import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"
import { fake, business } from "./_fake-a2p"
import { TwilioError } from "@/lib/twilio"

// The held A2P status reconciler against real Postgres, Twilio faked at the
// twilio-a2p boundary. Each test parks every other registration in the far
// future so only its own shops are due.
vi.mock("@/lib/twilio-a2p", async () => (await import("./_fake-a2p")).fakeA2pModule())
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

const MIN = 60_000
const ON = { A2P_RECONCILER_ENABLED: "true" }

describe.skipIf(!INTEGRATION)("held A2P status reconciler", () => {
  let db: SupabaseClient
  let provider: typeof import("@/lib/telephony-provider")
  let reconciler: typeof import("@/lib/a2p-reconciler")
  let encrypt: typeof import("@/lib/crypto").encryptSecret
  const seeds: Seeded[] = []
  const origin = "https://gradia.test"

  const shopRow = async (id: string) => (await db.from("shops").select("*").eq("id", id).single()).data
  const reg = async (id: string) => (await db.from("a2p_registrations").select("*").eq("shop_id", id).single()).data
  const run = (extra: Partial<Parameters<typeof reconciler.reconcileA2pRegistrations>[0]> = {}) =>
    reconciler.reconcileA2pRegistrations({ supabase: db, origin, env: ON, ...extra })
  const due = async (id: string) => expect((await db.from("a2p_registrations").update({ next_check_at: null }).eq("shop_id", id)).error).toBeNull()
  const subaccount = (shopId: string) => "AC" + shopId.replace(/-/g, "")

  async function approvedShop() {
    const s = await seedShop(db); seeds.push(s)
    expect((await db.from("shops").update({
      twilio_subaccount_sid: subaccount(s.shopId), twilio_subaccount_token_enc: encrypt("synthetic-sub-token"),
      gradia_number_e164: "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0"), gradia_number_sid: "PN" + "1".repeat(32), a2p_status: "unregistered",
    }).eq("id", s.shopId)).error).toBeNull()
    const shop = await shopRow(s.shopId)
    expect((await provider.startA2pRegistration({ supabase: db, shop, business: business(), origin })).ok).toBe(true)
    fake.brand = "APPROVED"; await provider.syncA2pStatus({ supabase: db, shop, origin })
    fake.campaign = "VERIFIED"; expect((await provider.syncA2pStatus({ supabase: db, shop, origin })).status).toBe("approved")
    await due(s.shopId)
    return s.shopId
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.TWILIO_PRIMARY_PROFILE_SID = "BU" + "9".repeat(32)
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL // the disposable stack (asserted by serviceClient)
    provider = await import("@/lib/telephony-provider")
    reconciler = await import("@/lib/a2p-reconciler")
    ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
    db = serviceClient()
  })
  beforeEach(async () => {
    fake.reset()
    expect((await db.from("a2p_registrations").update({ next_check_at: "2999-01-01T00:00:00Z" }).not("shop_id", "is", null)).error).toBeNull()
  })
  afterAll(async () => { for (const s of seeds) await cleanup(db, s) })

  it("with the flag off, a run reads and calls nothing", async () => {
    const id = await approvedShop()
    fake.calls.length = 0
    expect(await reconciler.reconcileA2pRegistrations({ supabase: db, origin, env: {} })).toEqual({ enabled: false })
    expect(fake.calls).toEqual([])
    expect((await reg(id)).next_check_at).toBeNull()
  })

  it("refreshes due registrations without a click, renewing evidence and scheduling the next check", async () => {
    const id = await approvedShop()
    await db.from("shops").update({ a2p_verified_at: new Date(Date.now() - 70 * 60 * MIN).toISOString() }).eq("id", id)
    fake.calls.length = 0
    const started = Date.now()
    expect(await run()).toMatchObject({ enabled: true, picked: 1, checked: 1, failed: 0, skipped: 0, errors: 0 })
    expect(fake.calls).toEqual(["campaign_status"])
    expect(Date.now() - Date.parse((await shopRow(id)).a2p_verified_at)).toBeLessThan(10 * MIN)
    const row = await reg(id)
    expect(row.check_failures).toBe(0)
    expect(Date.parse(row.next_check_at) - started).toBeGreaterThanOrEqual(6 * 60 * MIN - MIN)
    expect(await run()).toMatchObject({ picked: 0 }) // not due again yet
  })

  it("two concurrent runs never call the provider twice for one shop", async () => {
    const ids = [await approvedShop(), await approvedShop(), await approvedShop()]
    fake.calls.length = 0; fake.accounts.length = 0
    fake.slow.set("campaign_status", 150)
    const [a, b] = await Promise.all([run(), run()])
    expect(fake.count("campaign_status")).toBe(3)
    for (const id of ids) expect(fake.accounts.filter((x) => x.accountSid === subaccount(id))).toHaveLength(1)
    expect(a.enabled && b.enabled && a.checked + b.checked).toBe(3)
  })

  it("backs off exponentially on provider failure and resets after a success", async () => {
    const id = await approvedShop()
    fake.calls.length = 0
    const err = () => new TwilioError(503, "Synthetic Twilio outage")
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      fake.fail.set("campaign_status", err())
      const t = Date.now()
      expect(await run()).toMatchObject({ failed: 1 })
      const row = await reg(id)
      expect(row.check_failures).toBe(i + 1)
      waits.push(Math.round((Date.parse(row.next_check_at) - t) / MIN))
      await due(id)
    }
    expect(waits).toEqual([5, 10, 20])
    expect((await reg(id)).status).toBe("approved")
    expect(await run()).toMatchObject({ checked: 1 })
    expect((await reg(id)).check_failures).toBe(0)
  })

  it("one shop's failure or credentials never touch another shop", async () => {
    const down = await approvedShop()
    const up = await approvedShop()
    fake.calls.length = 0; fake.accounts.length = 0
    fake.failAccount.set(subaccount(down), new TwilioError(401, "Synthetic credential refusal"))
    expect(await run()).toMatchObject({ picked: 2, checked: 1, failed: 1, errors: 0 })
    expect(await reg(down)).toMatchObject({ check_failures: 1, last_check_failure_kind: "provider_error" })
    expect(await reg(up)).toMatchObject({ check_failures: 0, last_check_failure_kind: null })
    expect(new Set(fake.accounts.map((x) => x.accountSid))).toEqual(new Set([subaccount(down), subaccount(up)]))
    expect(fake.accounts.every((x) => x.accountSid === subaccount(down) || x.accountSid === subaccount(up))).toBe(true)
  })

  it("never picks more than the batch, oldest first", async () => {
    const ids = [await approvedShop(), await approvedShop(), await approvedShop()]
    for (const [i, id] of ids.entries()) {
      await db.from("a2p_registrations").update({ next_check_at: new Date(Date.now() - (10 - i) * MIN).toISOString() }).eq("shop_id", id)
    }
    fake.calls.length = 0; fake.accounts.length = 0
    expect(await run({ batch: 2 })).toMatchObject({ picked: 2, checked: 2 })
    expect(fake.accounts.map((x) => x.accountSid)).toEqual([subaccount(ids[0]), subaccount(ids[1])])
  })

  it("a registration with nothing to read is rescheduled, so it can't starve the batch", async () => {
    const s = await seedShop(db); seeds.push(s)
    expect((await db.from("a2p_registrations").insert({ shop_id: s.shopId, status: "brand_pending", business: business() })).error).toBeNull()
    await db.from("shops").update({ twilio_subaccount_sid: subaccount(s.shopId), twilio_subaccount_token_enc: encrypt("synthetic-sub-token") }).eq("id", s.shopId)
    expect(await run()).toMatchObject({ picked: 1, skipped: 1 })
    expect(fake.calls).toEqual([])
    expect((await reg(s.shopId)).next_check_at).not.toBeNull()
    expect(await run()).toMatchObject({ picked: 0 })
  })
})
