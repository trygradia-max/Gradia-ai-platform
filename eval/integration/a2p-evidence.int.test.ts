import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, cleanup, type Seeded } from "./_db"
import { fake, business } from "./_fake-a2p"
import { TwilioError } from "@/lib/twilio"

// Carrier-approval evidence (October 20 policy): the send gate opens a Gradia
// number only while a VERIFIED campaign read is recent, a failed check never
// renews that, and only the registration's claim holder writes it. Real
// Postgres on the disposable stack; Twilio faked at the twilio-a2p boundary.
vi.mock("@/lib/twilio-a2p", async () => (await import("./_fake-a2p")).fakeA2pModule())
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

const HOUR = 3_600_000

describe.skipIf(!INTEGRATION_WITH_SESSION)("A2P evidence freshness and outage behaviour", () => {
  let db: SupabaseClient
  let provider: typeof import("@/lib/telephony-provider")
  let encrypt: typeof import("@/lib/crypto").encryptSecret
  const seeds: Seeded[] = []
  const origin = "https://gradia.test"
  const password = "Synthetic-pass-" + Math.random().toString(36).slice(2)

  async function numberedShop(withPassword = false) {
    const s = await seedShop(db, withPassword ? { password } : {}); seeds.push(s)
    expect((await db.from("shops").update({
      twilio_subaccount_sid: "AC" + s.shopId.replace(/-/g, ""), twilio_subaccount_token_enc: encrypt("synthetic-sub-token"),
      gradia_number_e164: "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0"), gradia_number_sid: "PN" + "1".repeat(32), a2p_status: "unregistered",
    }).eq("id", s.shopId)).error).toBeNull()
    return { seed: s, shop: await shopRow(s.shopId) }
  }
  const shopRow = async (id: string) => (await db.from("shops").select("*").eq("id", id).single()).data
  const reg = async (id: string) => (await db.from("a2p_registrations").select("*").eq("shop_id", id).single()).data
  const sync = (shop: { id: string }) => provider.syncA2pStatus({ supabase: db, shop: shop as never, origin })
  const gate = async (id: string, now = new Date()) => {
    const s = await shopRow(id)
    return provider.smsGateForShop(s, s.gradia_number_e164, now)
  }
  /** Ages the stored evidence, as if the last VERIFIED read was `hours` ago. */
  const age = async (id: string, hours: number) => {
    const at = new Date(Date.now() - hours * HOUR).toISOString()
    expect((await db.from("shops").update({ a2p_verified_at: at }).eq("id", id)).error).toBeNull()
    expect((await db.from("a2p_registrations").update({ last_verified_at: at }).eq("shop_id", id)).error).toBeNull()
    return at
  }
  async function approvedShop(withPassword = false) {
    const { seed, shop } = await numberedShop(withPassword)
    expect((await provider.startA2pRegistration({ supabase: db, shop, business: business(), origin })).ok).toBe(true)
    fake.brand = "APPROVED"
    expect((await sync(shop)).status).toBe("campaign_pending")
    fake.campaign = "VERIFIED"
    expect((await sync(shop)).status).toBe("approved")
    fake.calls.length = 0
    return { seed, shop: await shopRow(shop.id) }
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.TWILIO_PRIMARY_PROFILE_SID = "BU" + "9".repeat(32)
    process.env.GRADIA_DASHBOARD_URL = "https://gradia.test"
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL // the disposable stack (asserted by serviceClient)
    provider = await import("@/lib/telephony-provider")
    ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
    db = serviceClient()
  })
  beforeEach(() => fake.reset())
  afterEach(() => { delete process.env.A2P_EVIDENCE_MAX_AGE_HOURS })
  afterAll(async () => { for (const s of seeds) await cleanup(db, s) })

  it("a VERIFIED read records evidence on the registration and the shop together, and opens texting", async () => {
    const { shop } = await approvedShop()
    const row = await reg(shop.id)
    expect(row.last_verified_at).not.toBeNull()
    expect(row.last_checked_at).toBe(row.last_verified_at)
    expect(shop.a2p_verified_at).toBe(row.last_verified_at)
    expect(await gate(shop.id)).toEqual({ allowed: true })
  })

  it("stale evidence holds an approved number as 'check overdue', and missing evidence is stale", async () => {
    const { shop } = await approvedShop()
    await age(shop.id, 73)
    expect(await gate(shop.id)).toEqual({ allowed: false, reason: expect.stringContaining("check overdue") })
    expect((await shopRow(shop.id)).a2p_status).toBe("approved")
    expect((await db.from("shops").update({ a2p_verified_at: null }).eq("id", shop.id)).error).toBeNull()
    expect((await gate(shop.id)).allowed).toBe(false)
  })

  it("an outage renews nothing: approved stays approved, the failure is recorded, and texting closes once evidence ages out", async () => {
    const { shop } = await approvedShop()
    const before = await age(shop.id, 70)
    fake.fail.set("campaign_status", new TwilioError(503, "Synthetic Twilio outage"))
    expect((await sync(shop)).status).toBe("approved")
    const row = await reg(shop.id)
    expect(row).toMatchObject({ status: "approved", last_check_failure_kind: "provider_unreachable" })
    expect(row.last_check_failed_at).not.toBeNull()
    expect(Date.parse(row.last_verified_at)).toBe(Date.parse(before))
    expect(Date.parse((await shopRow(shop.id)).a2p_verified_at)).toBe(Date.parse(before))
    expect((await gate(shop.id)).allowed).toBe(true) // still inside 72 hours
    expect(await gate(shop.id, new Date(Date.now() + 3 * HOUR))).toEqual({ allowed: false, reason: expect.stringContaining("check overdue") })

    fake.fail.set("campaign_status", new TwilioError(401, "Synthetic auth refusal"))
    await sync(shop)
    expect((await reg(shop.id)).last_check_failure_kind).toBe("provider_error")
  })

  it("suspension closes texting immediately and clears the evidence; VERIFIED again reopens and renews it", async () => {
    const { shop } = await approvedShop()
    const first = (await reg(shop.id)).last_verified_at
    fake.campaign = "SUSPENDED"
    expect((await sync(shop)).status).toBe("suspended")
    expect(await shopRow(shop.id)).toMatchObject({ a2p_status: "suspended", a2p_verified_at: null })
    expect((await gate(shop.id)).allowed).toBe(false)
    expect((await reg(shop.id)).last_check_failure_kind).toBeNull() // a carrier state, not a failed check

    fake.campaign = "VERIFIED"
    expect((await sync(shop)).status).toBe("approved")
    const renewed = await reg(shop.id)
    expect(Date.parse(renewed.last_verified_at)).toBeGreaterThan(Date.parse(first))
    expect((await gate(shop.id)).allowed).toBe(true)
  })

  it("two concurrent refreshes make one provider read and renew evidence once", async () => {
    const { shop } = await approvedShop()
    await age(shop.id, 70)
    fake.slow.set("campaign_status", 150)
    const results = await Promise.all([sync(shop), sync(shop)])
    expect(results.map((r) => r.status)).toEqual(["approved", "approved"])
    expect(fake.count("campaign_status")).toBe(1)
    const row = await reg(shop.id)
    expect(Date.now() - Date.parse(row.last_verified_at)).toBeLessThan(HOUR)
    expect(row.claim_token).toBeNull()
  })

  it("a refresh that can't take the claim reads nothing and renews nothing", async () => {
    const { shop } = await approvedShop()
    const before = await age(shop.id, 70)
    const held = await db.rpc("a2p_claim_registration", { p_shop_id: shop.id, p_statuses: ["approved"], p_lease_seconds: 60 })
    expect(held.data).toMatch(/^[0-9a-f-]{36}$/)
    expect((await sync(shop)).status).toBe("approved")
    expect(fake.calls).toEqual([])
    expect(Date.parse((await reg(shop.id)).last_verified_at)).toBe(Date.parse(before))
  })

  it("the configured age can shorten evidence life but never extend it past 7 days", async () => {
    const { shop } = await approvedShop()
    await age(shop.id, 30)
    process.env.A2P_EVIDENCE_MAX_AGE_HOURS = "24"
    expect((await gate(shop.id)).allowed).toBe(false)
    process.env.A2P_EVIDENCE_MAX_AGE_HOURS = "100000"
    await age(shop.id, 8 * 24)
    expect((await gate(shop.id)).allowed).toBe(false)
    await age(shop.id, 6 * 24)
    expect((await gate(shop.id)).allowed).toBe(true)
  })

  it("only the claim holder records evidence, and only for an approved registration", async () => {
    const { shop } = await approvedShop()
    expect((await db.rpc("a2p_finish_registration", {
      p_shop_id: shop.id, p_token: "00000000-0000-4000-8000-000000000000", p_check: "verified",
    })).data).toBe(false)
    const token = (await db.rpc("a2p_claim_registration", { p_shop_id: shop.id, p_statuses: ["approved"], p_lease_seconds: 60 })).data
    const refused = await db.rpc("a2p_finish_registration", { p_shop_id: shop.id, p_token: token, p_status: "campaign_pending", p_check: "verified" })
    expect(refused.error).not.toBeNull()
    expect((await reg(shop.id)).status).toBe("approved") // the refused call changed nothing
    expect((await db.rpc("a2p_finish_registration", { p_shop_id: shop.id, p_token: token, p_check: "failed" })).error).not.toBeNull()
  })

  it("an owner can't approve their own number or forge evidence, but can still reset it on release", async () => {
    const { seed, shop } = await approvedShop(true)
    const owner = await ownerSessionClient(seed.email, password)
    expect((await owner.from("shops").update({ a2p_status: "unregistered" }).eq("id", shop.id)).error).toBeNull()
    const self = await owner.from("shops").update({ a2p_status: "approved" }).eq("id", shop.id)
    expect(self.error?.details).toBe("a2p_server_written")
    const forged = await owner.from("shops").update({ a2p_verified_at: new Date().toISOString() }).eq("id", shop.id)
    expect(forged.error?.details).toBe("a2p_server_written")
    expect((await owner.from("shops").update({ a2p_verified_at: null }).eq("id", shop.id)).error).toBeNull()
    expect((await shopRow(shop.id)).a2p_status).toBe("unregistered")
  })
})
