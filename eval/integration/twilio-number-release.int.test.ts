import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"
import { createTwilioFake, MASTER } from "./_twilio-fake"

// Audit of uncertain provider outcomes in the number lifecycle (purchase,
// provision, release, disconnect), against real Postgres and a fake Twilio.
// Each test states what must hold: no duplicate billed number, no stranded
// paid number, no double metering, no number routing to Gradia for no shop.

const current = vi.hoisted(() => ({ shopId: "" }))
vi.mock("@/lib/shop", () => ({
  requireUser: async () => ({ id: "synthetic-owner" }),
  requireShop: async () => ({ id: current.shopId, name: "Fictional Detail Co" }),
  getOptionalShop: async () => ({ id: current.shopId, name: "Fictional Detail Co" }),
  ACTIVE_SHOP_COOKIE: "gradia_active_shop",
}))
vi.mock("@/lib/supabase/server", async () => ({ createClient: async () => (await import("./_db")).serviceClient() }))
// `failNumberSave`: the next service-role write of twilio_phone_number fails
// (a failed or lost save); everything else reaches the database.
const svc = vi.hoisted(() => ({ failNumberSave: false }))
vi.mock("@/lib/supabase/service", async () => {
  const { serviceClient } = await import("./_db")
  return {
    createServiceClient: () => {
      const client = serviceClient()
      return new Proxy(client, {
        get(target, key) {
          if (key !== "from") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v }
          return (table: string) => {
            const builder = target.from(table)
            if (table !== "shops") return builder
            const update = builder.update.bind(builder)
            ;(builder as unknown as { update: unknown }).update = (values: Record<string, unknown>, ...rest: unknown[]) => {
              const filter = (update as (...a: unknown[]) => unknown)(values, ...rest) as Record<string, unknown>
              if (!svc.failNumberSave || !("twilio_phone_number" in values)) return filter
              svc.failNumberSave = false
              const fail = { data: null, error: { message: "Synthetic write failure" } }
              const failing: Record<string, unknown> = { then: (ok: (v: unknown) => unknown) => Promise.resolve(fail).then(ok) }
              for (const m of ["eq", "is", "select", "single", "maybeSingle"]) failing[m] = () => failing
              return failing
            }
            return builder
          }
        },
      })
    },
  }
})
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "gradia.test" }), cookies: async () => ({ get: () => undefined, set: () => undefined }) }))

const fake = createTwilioFake()
const twilio = fake.state
const hex = (n: number) => randomBytes(n).toString("hex")
const e164 = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")

let db: SupabaseClient
let encrypt: typeof import("@/lib/crypto").encryptSecret
let actions: typeof import("@/app/actions/twilio-provision")
let shopActions: typeof import("@/app/actions/shop")
let provider: typeof import("@/lib/telephony-provider")
const shops: Seeded[] = []
const saved: Record<string, string | undefined> = {}

const row = async (shopId: string) => (await db.from("shops").select("*").eq("id", shopId).single()).data!
const metered = async (shopId: string) =>
  (await db.from("usage_events").select("vendor_ref").eq("shop_id", shopId).eq("kind", "number_monthly")).data!.map((u) => u.vendor_ref)
async function gradiaShop() {
  const s = await seedShop(db); shops.push(s)
  expect((await db.from("shops").update({ plan: "active" }).eq("id", s.shopId)).error).toBeNull()
  current.shopId = s.shopId
  return s
}
const buy = async (s: Seeded, number = e164()) =>
  provider.purchaseNumber({ supabase: db, shop: (await row(s.shopId)) as Parameters<typeof provider.purchaseNumber>[0]["shop"], e164: number, origin: "https://gradia.test" })
const subaccount = async (s: Seeded) => (await row(s.shopId)).twilio_subaccount_sid as string

beforeAll(async () => {
  if (!INTEGRATION) return
  for (const k of ["ENCRYPTION_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PILOT_SHOP_NUMBERS", "GRADIA_DASHBOARD_URL"]) saved[k] = process.env[k]
  process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
  process.env.TWILIO_ACCOUNT_SID = MASTER.sid
  process.env.TWILIO_AUTH_TOKEN = MASTER.token
  process.env.GRADIA_DASHBOARD_URL = "https://gradia.test"
  process.env.TWILIO_PILOT_SHOP_NUMBERS = ""
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => fake.fetchImpl(realFetch, input, init)))
  ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
  actions = await import("@/app/actions/twilio-provision")
  shopActions = await import("@/app/actions/shop")
  provider = await import("@/lib/telephony-provider")
  db = serviceClient()
})
afterAll(async () => {
  if (!INTEGRATION) return
  vi.unstubAllGlobals()
  for (const s of shops) await cleanup(db, s)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
beforeEach(() => fake.reset())

describe.skipIf(!INTEGRATION)("release: uncertain outcomes", () => {
  it("a release whose response is lost (released at Twilio) heals on retry; nothing stays billed", async () => {
    const s = await gradiaShop()
    expect(await buy(s)).toMatchObject({ ok: true })
    const sub = await subaccount(s)
    twilio.releaseFaults = ["lose_response"]
    expect(await actions.releaseTwilioNumber()).toMatchObject({ ok: false })
    expect(fake.onAccount(sub)).toHaveLength(0) // gone at Twilio, so not billed
    expect((await row(s.shopId)).gradia_number_e164).not.toBeNull() // still shown until the retry
    expect(await actions.releaseTwilioNumber()).toEqual({ ok: true })
    const after = await row(s.shopId)
    expect([after.twilio_phone_number, after.gradia_number_e164, after.gradia_number_sid]).toEqual([null, null, null])
  })

  it("a release Twilio refuses changes nothing: the number stays stored, billed and routed; retry releases it", async () => {
    const s = await gradiaShop()
    expect(await buy(s)).toMatchObject({ ok: true })
    const sub = await subaccount(s)
    const before = await row(s.shopId)
    twilio.releaseFaults = ["fail"]
    expect(await actions.releaseTwilioNumber()).toMatchObject({ ok: false })
    expect(fake.onAccount(sub).map((n) => n.sid)).toEqual([before.gradia_number_sid])
    expect((await row(s.shopId)).twilio_phone_number).toBe(before.twilio_phone_number)
    expect(await actions.releaseTwilioNumber()).toEqual({ ok: true })
    expect(fake.onAccount(sub)).toHaveLength(0)
  })

  it("release then re-buy: one live number, each number metered once, A2P back to unregistered", async () => {
    const s = await gradiaShop()
    const first = await buy(s)
    expect(first).toMatchObject({ ok: true })
    const firstSid = (await row(s.shopId)).gradia_number_sid
    expect(await actions.releaseTwilioNumber()).toEqual({ ok: true })
    const second = await buy(s)
    expect(second).toMatchObject({ ok: true })
    const after = await row(s.shopId)
    expect(after.gradia_number_sid).not.toBe(firstSid)
    expect(fake.onAccount(await subaccount(s)).map((n) => n.sid)).toEqual([after.gradia_number_sid])
    expect((await metered(s.shopId)).sort()).toEqual([firstSid, after.gradia_number_sid].sort())
    expect(after.a2p_status).toBe("unregistered")
  })

  it("a shop with no usable credentials can't release through another account (explicit-null refusal)", async () => {
    const s = await gradiaShop()
    expect((await db.from("shops").update({ twilio_phone_number: e164() }).eq("id", s.shopId)).error).toBeNull()
    expect(await actions.releaseTwilioNumber()).toMatchObject({ ok: false })
    expect(twilio.calls).toHaveLength(0)
  })
})

describe.skipIf(!INTEGRATION)("purchase: a provisioning call still in flight", () => {
  it("a second purchase while the first is still provisioning doesn't buy a second number", async () => {
    const s = await gradiaShop()
    await provider.ensureSubaccount(db, (await row(s.shopId)) as Parameters<typeof provider.ensureSubaccount>[1])
    twilio.provisionDelay = 800
    const first = buy(s)
    await new Promise((r) => setTimeout(r, 200)) // the first is now inside the provisioning call
    const second = await buy(s)
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining("already in progress") })
    const settled = await first
    expect(settled).toMatchObject({ ok: true })
    expect(twilio.provisions).toBe(1)
    expect(await metered(s.shopId)).toHaveLength(1)
    // Once the first finishes, its claim is gone and the number is stored.
    const after = await row(s.shopId)
    expect(after.number_purchase_claim).toBeNull()
    expect(after.gradia_number_e164).toBe((settled as { e164: string }).e164)
  })

  it("a provisioning call that outlives the claim: one number stored and metered, and a duplicate whose release fails is swept by the next release", async () => {
    const s = await gradiaShop()
    await provider.ensureSubaccount(db, (await row(s.shopId)) as Parameters<typeof provider.ensureSubaccount>[1])
    const sub = await subaccount(s)
    const slow = async () =>
      provider.purchaseNumber({ supabase: db, shop: (await row(s.shopId)) as Parameters<typeof provider.purchaseNumber>[0]["shop"], e164: e164(), origin: "https://gradia.test", claimTtlMs: 100 })
    twilio.provisionDelay = 800
    twilio.releaseFaults = ["fail"] // the loser can't release its duplicate
    const first = slow()
    await new Promise((r) => setTimeout(r, 300)) // the first's claim is stale; its call is still in flight
    const results = await Promise.all([first, slow()])
    const stored = await row(s.shopId)
    for (const r of results) expect(r).toMatchObject({ ok: true, e164: stored.gradia_number_e164 })
    expect(twilio.provisions).toBe(2) // the bounded worst case: only past the TTL
    expect(await metered(s.shopId)).toEqual([stored.gradia_number_sid])
    expect(fake.onAccount(sub)).toHaveLength(2) // the stray duplicate is still billed...
    expect(stored.number_purchase_claim).toBeNull() // the later claim was cleared; the stale one never cleared it early
    expect(await actions.releaseTwilioNumber()).toEqual({ ok: true })
    expect(fake.onAccount(sub)).toHaveLength(0) // ...until the release sweeps it
  })

  it("a crashed purchase's claim stops blocking after the TTL", async () => {
    const s = await gradiaShop()
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    expect((await db.from("shops").update({ number_purchase_claim: crypto.randomUUID(), number_purchase_claimed_at: old }).eq("id", s.shopId)).error).toBeNull()
    expect(await buy(s)).toMatchObject({ ok: true })
    const live = new Date().toISOString()
    const other = await gradiaShop()
    expect((await db.from("shops").update({ number_purchase_claim: crypto.randomUUID(), number_purchase_claimed_at: live }).eq("id", other.shopId)).error).toBeNull()
    expect(await buy(other)).toMatchObject({ ok: false, error: expect.stringContaining("already in progress") })
    expect(twilio.provisions).toBe(1)
  })

  it("a duplicate whose release fails is not left billed on the subaccount after the shop releases", async () => {
    const s = await gradiaShop()
    await provider.ensureSubaccount(db, (await row(s.shopId)) as Parameters<typeof provider.ensureSubaccount>[1])
    const sub = await subaccount(s)
    // A stray number on the shop's subaccount, as a failed duplicate release leaves it.
    fake.addNumber(sub, e164())
    expect(await buy(s)).toMatchObject({ ok: true }) // adopts the stray (one number on the subaccount)
    fake.addNumber(sub, e164()) // and another stray appears later
    expect(await actions.releaseTwilioNumber()).toEqual({ ok: true })
    expect(fake.onAccount(sub)).toHaveLength(0)
  })
})

describe.skipIf(!INTEGRATION)("BYO provision: a failed save", () => {
  const BYO = { sid: "AC" + hex(16), token: "synthetic-byo-" + hex(8) }
  beforeAll(() => fake.addAccount(BYO.sid, BYO.token))
  async function byoShop() {
    const s = await seedShop(db); shops.push(s)
    expect((await db.from("shops").update({ twilio_account_sid_enc: encrypt(BYO.sid), twilio_auth_token_enc: encrypt(BYO.token) }).eq("id", s.shopId)).error).toBeNull()
    current.shopId = s.shopId
    return s
  }
  async function withFailingNumberSave<T>(run: () => Promise<T>): Promise<T> {
    svc.failNumberSave = true
    try { return await run() } finally { svc.failNumberSave = false }
  }

  it("a failed save whose rollback release also fails strands nothing: the retry adopts the number", async () => {
    const s = await byoShop()
    const number = e164()
    twilio.releaseFaults = ["fail", "fail"]
    expect(await withFailingNumberSave(() => actions.provisionTwilioNumber({ phoneNumber: number }))).toMatchObject({ ok: false })
    expect(fake.onAccount(BYO.sid).filter((n) => n.phone_number === number)).toHaveLength(1)
    // Retry: the number must end up stored on the shop, not stranded on the owner's account.
    expect(await actions.provisionTwilioNumber({ phoneNumber: number })).toMatchObject({ ok: true, phoneNumber: number })
    expect((await row(s.shopId)).twilio_phone_number).toBe(number)
    expect(twilio.provisions).toBe(1)
  })

  it("a save that failed is never answered by releasing the number", async () => {
    const s = await byoShop()
    const number = e164()
    expect(await withFailingNumberSave(() => actions.provisionTwilioNumber({ phoneNumber: number }))).toMatchObject({ ok: false })
    expect(twilio.releases).toHaveLength(0)
    expect(fake.onAccount(BYO.sid).filter((n) => n.phone_number === number)).toHaveLength(1)
    expect(await actions.provisionTwilioNumber({ phoneNumber: number })).toMatchObject({ ok: true })
    expect((await row(s.shopId)).twilio_phone_number).toBe(number)
  })

  it("concurrent BYO provisions buy one number", async () => {
    const s = await byoShop()
    twilio.provisionDelay = 300
    const results = await Promise.all([e164(), e164()].map((phoneNumber) => actions.provisionTwilioNumber({ phoneNumber })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(twilio.provisions).toBe(1)
    const stored = (await row(s.shopId)).twilio_phone_number
    expect(fake.onAccount(BYO.sid).filter((n) => n.phone_number === stored)).toHaveLength(1)
  })

  it("a BYO provisioning response lost in transit is adopted, not bought again", async () => {
    const s = await byoShop()
    const number = e164()
    twilio.provisionFault = "lose_response"
    expect(await actions.provisionTwilioNumber({ phoneNumber: number })).toMatchObject({ ok: true, phoneNumber: number })
    expect(twilio.provisions).toBe(1)
    expect((await row(s.shopId)).twilio_phone_number).toBe(number)
  })

  it("a second BYO provision for a shop that already has a number buys nothing", async () => {
    const s = await byoShop()
    expect(await actions.provisionTwilioNumber({ phoneNumber: e164() })).toMatchObject({ ok: true })
    const stored = (await row(s.shopId)).twilio_phone_number
    expect(await actions.provisionTwilioNumber({ phoneNumber: e164() })).toMatchObject({ ok: false })
    expect(twilio.provisions).toBe(1)
    expect((await row(s.shopId)).twilio_phone_number).toBe(stored)
  })
})

describe.skipIf(!INTEGRATION)("disconnect", () => {
  it("disconnecting a Gradia number keeps it on the shop (still billed, re-connectable), so it never routes for no shop", async () => {
    const s = await gradiaShop()
    expect(await buy(s)).toMatchObject({ ok: true })
    const before = await row(s.shopId)
    expect(await shopActions.disconnectSms()).toMatchObject({ ok: true })
    const after = await row(s.shopId)
    expect(after.twilio_phone_number).toBeNull()
    expect(after.gradia_number_e164).toBe(before.gradia_number_e164) // still owned by this shop
    expect(fake.onAccount(await subaccount(s))).toHaveLength(1)
  })
})
