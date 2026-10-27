import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"
import { fake, business } from "./_fake-a2p"
import { TwilioError } from "@/lib/twilio"

// Audit of uncertain provider outcomes (October 20 brief, priority 3, A2P
// part). Each case asks: across requests and retries, can the registration
// create a second billed (or orphaned) Twilio resource? This is
// service-level idempotency: a database claim plus provider lookups before
// any create, not a UI busy flag. Real Postgres on the disposable stack;
// Twilio faked at the twilio-a2p boundary.
vi.mock("@/lib/twilio-a2p", async () => (await import("./_fake-a2p")).fakeA2pModule())
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

const lostResponse = () => new TwilioError(503, "Synthetic lost response")

describe.skipIf(!INTEGRATION)("A2P uncertain provider outcomes", () => {
  let db: SupabaseClient
  let provider: typeof import("@/lib/telephony-provider")
  let encrypt: typeof import("@/lib/crypto").encryptSecret
  const seeds: Seeded[] = []
  const origin = "https://gradia.test"

  async function numberedShop() {
    const s = await seedShop(db); seeds.push(s)
    expect((await db.from("shops").update({
      twilio_subaccount_sid: "AC" + s.shopId.replace(/-/g, ""), twilio_subaccount_token_enc: encrypt("synthetic-sub-token"),
      gradia_number_e164: "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0"), gradia_number_sid: "PN" + "1".repeat(32), a2p_status: "unregistered",
    }).eq("id", s.shopId)).error).toBeNull()
    return (await db.from("shops").select("*").eq("id", s.shopId).single()).data
  }
  const start = (shop: { id: string }) => provider.startA2pRegistration({ supabase: db, shop: shop as never, business: business(), origin })
  const sync = (shop: { id: string }) => provider.syncA2pStatus({ supabase: db, shop: shop as never, origin })
  const reg = async (id: string) => (await db.from("a2p_registrations").select("*").eq("shop_id", id).single()).data

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.TWILIO_PRIMARY_PROFILE_SID = "BU" + "9".repeat(32)
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL // the disposable stack (asserted by serviceClient)
    provider = await import("@/lib/telephony-provider")
    ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
    db = serviceClient()
  })
  beforeEach(() => fake.reset())
  afterAll(async () => { for (const s of seeds) await cleanup(db, s) })

  it("a brand created at Twilio whose response was lost is adopted on retry, not registered again", async () => {
    const shop = await numberedShop()
    fake.lost.set("brand", lostResponse())
    expect((await start(shop)).ok).toBe(false)
    expect(await reg(shop.id)).toMatchObject({ status: "draft", brand_sid: null, failed_step: "brand", retryable: true })
    expect(await start(shop)).toEqual({ ok: true })
    expect(fake.count("brand")).toBe(1)
    expect(fake.brands).toHaveLength(1)
    expect((await reg(shop.id)).brand_sid).toBe(fake.brands[0].brandSid)
  })

  it("a messaging service created at Twilio whose response was lost is adopted on retry, not created again", async () => {
    const shop = await numberedShop()
    expect((await start(shop)).ok).toBe(true)
    fake.brand = "APPROVED"
    fake.lost.set("messaging_service", lostResponse())
    expect((await sync(shop)).status).toBe("brand_pending")
    expect((await reg(shop.id)).messaging_service_sid).toBeNull()
    expect((await sync(shop)).status).toBe("campaign_pending")
    expect(fake.count("messaging_service")).toBe(1)
    expect(fake.services).toHaveLength(1)
    expect((await reg(shop.id)).messaging_service_sid).toBe(fake.services[0].messagingServiceSid)
    expect(fake.count("campaign")).toBe(1)
  })

  it("adoption only looks inside the shop's own subaccount", async () => {
    const other = await numberedShop()
    expect((await start(other)).ok).toBe(true) // a brand in another subaccount
    const shop = await numberedShop()
    fake.calls.length = 0
    expect(await start(shop)).toEqual({ ok: true })
    expect(fake.count("brand")).toBe(1)
    expect((await reg(shop.id)).brand_sid).not.toBe((await reg(other.id)).brand_sid)
  })

  it("a holder whose provider call outlives its lease can no longer write; a second claimer takes over", async () => {
    const shop = await numberedShop()
    fake.slow.set("brand", 400)
    const first = start(shop)
    await new Promise((r) => setTimeout(r, 150)) // the first holder is inside the slow brand call
    // Force what a call longer than the lease would cause.
    expect((await db.from("a2p_registrations").update({ claimed_until: new Date(Date.now() - 1000).toISOString() }).eq("shop_id", shop.id)).error).toBeNull()
    fake.slow.clear()
    const second = await start(shop)
    const late = await first
    expect([second.ok, late.ok]).toEqual([true, false]) // the stale holder's save is refused
    const row = await reg(shop.id)
    expect(row).toMatchObject({ status: "brand_pending", claim_token: null })
    // The stale holder's brand had not reached the list when the second claimer
    // looked, so the provider saw two brand calls. Production calls time out
    // (twilio-a2p A2P_PROVIDER_TIMEOUT_MS) well inside the lease, so a live
    // holder can't be overtaken; this test documents why that bound matters.
    expect(fake.count("brand")).toBe(2)
    expect(row.brand_sid).toBe(fake.brands[0].brandSid) // the second claimer's; the stale one is orphaned
  })

  it("R9 residual: a customer profile created but not finished (entity, evaluate or submit failed) is rebuilt on retry", async () => {
    const shop = await numberedShop()
    fake.lost.set("profile", lostResponse())
    expect((await start(shop)).ok).toBe(false)
    expect(await start(shop)).toEqual({ ok: true })
    // Two TrustHub customer profiles: the first is an unsubmitted draft bundle.
    // Unbilled clutter, not a billed duplicate; finishing it needs sub-step
    // checkpoints inside registerBusinessProfile (follow-up, not fixed here).
    expect(fake.count("profile")).toBe(2)
    expect(fake.count("brand")).toBe(1)
  })
})
