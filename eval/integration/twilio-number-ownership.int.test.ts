import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  INTEGRATION,
  INTEGRATION_WITH_SESSION,
  serviceClient,
  ownerSessionClient,
  seedShop,
  cleanup,
  type Seeded,
} from "./_db"

// Review findings I1 (texting number is server-written; ownership checked on
// the shop's own account) and R8 (number purchase is single-flight), against
// real Postgres and a fake Twilio REST API (an in-memory store behind a
// stubbed fetch, with Basic auth checked per account). Nothing reaches Twilio.

type Num = { sid: string; phone_number: string; account: string }
const hex = (n: number) => randomBytes(n).toString("hex")
const MASTER = { sid: "AC" + "0".repeat(32), token: "synthetic-master-token" }
const twilio = {
  tokens: new Map<string, string>(), // account sid → auth token
  friendly: new Map<string, string>(), // subaccount sid → friendly name
  numbers: new Map<string, Num>(), // PN sid → number
  provisions: 0,
  releases: [] as string[],
  calls: [] as { method: string; account: string | null; path: string }[],
  failLookup: false,
  loseProvisionResponse: false,
  provisionDelay: 0,
}
const onAccount = (account: string) => [...twilio.numbers.values()].filter((n) => n.account === account)

const realFetch = globalThis.fetch
async function fakeTwilio(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  // Only the Twilio API is faked; the disposable database is reached for real.
  if (url.hostname !== "api.twilio.com") return realFetch(input, init)
  const method = (init?.method ?? "GET").toUpperCase()
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
  const [user, pass] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":")
  const account = url.pathname.match(/\/Accounts\/(AC[0-9a-f]{32})\//)?.[1] ?? null
  twilio.calls.push({ method, account, path: url.pathname })
  if (twilio.tokens.get(user) !== pass) return json({ message: "unauthorized" }, 401)

  if (url.pathname.endsWith("/Accounts.json") && method === "POST") {
    const sub = { sid: "AC" + hex(16), auth_token: hex(16) }
    twilio.tokens.set(sub.sid, sub.auth_token)
    twilio.friendly.set(sub.sid, new URLSearchParams(String(init?.body)).get("FriendlyName") ?? "")
    return json({ ...sub, friendly_name: twilio.friendly.get(sub.sid), status: "active" }, 201)
  }
  if (url.pathname.endsWith("/Accounts.json") && method === "GET") {
    const name = url.searchParams.get("FriendlyName")
    return json({ accounts: [...twilio.friendly].filter(([, n]) => n === name).map(([sid, n]) => ({ sid, auth_token: twilio.tokens.get(sid), friendly_name: n, status: "active" })) })
  }
  // A caller may only touch its own account's numbers.
  if (account && account !== user) return json({ message: "forbidden" }, 403)
  if (account && url.pathname.endsWith("/IncomingPhoneNumbers.json") && method === "GET") {
    if (twilio.failLookup) return json({ message: "synthetic outage" }, 503)
    const filter = url.searchParams.get("PhoneNumber")
    return json({ incoming_phone_numbers: onAccount(account).filter((n) => !filter || n.phone_number === filter) })
  }
  if (account && url.pathname.endsWith("/IncomingPhoneNumbers.json") && method === "POST") {
    const phone = new URLSearchParams(String(init?.body)).get("PhoneNumber") ?? ""
    if (twilio.provisionDelay) await new Promise((r) => setTimeout(r, twilio.provisionDelay))
    if ([...twilio.numbers.values()].some((n) => n.phone_number === phone)) return json({ message: "not available" }, 400)
    const n = { sid: "PN" + hex(16), phone_number: phone, account }
    twilio.numbers.set(n.sid, n)
    twilio.provisions += 1
    if (twilio.loseProvisionResponse) { twilio.loseProvisionResponse = false; throw new TypeError("fetch failed (synthetic lost response)") }
    return json(n, 201)
  }
  const pn = url.pathname.match(/\/IncomingPhoneNumbers\/(PN[0-9a-f]{32})\.json$/)?.[1]
  if (account && pn && method === "DELETE") {
    if (twilio.numbers.get(pn)?.account !== account) return json({ message: "not found" }, 404)
    twilio.numbers.delete(pn)
    twilio.releases.push(pn)
    return new Response(null, { status: 204 })
  }
  return json({ message: `unexpected ${method} ${url.pathname}` }, 500)
}

let db: SupabaseClient
let encrypt: typeof import("@/lib/crypto").encryptSecret
const shops: Seeded[] = []
const savedEnv: Record<string, string | undefined> = {}
const e164 = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const storedNumber = async (shopId: string) =>
  (await db.from("shops").select("twilio_phone_number, gradia_number_e164, gradia_number_sid").eq("id", shopId).single()).data!

beforeAll(async () => {
  if (!INTEGRATION) return
  for (const k of ["ENCRYPTION_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PILOT_SHOP_NUMBERS", "GRADIA_DASHBOARD_URL"]) savedEnv[k] = process.env[k]
  process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
  process.env.TWILIO_ACCOUNT_SID = MASTER.sid
  process.env.TWILIO_AUTH_TOKEN = MASTER.token
  process.env.GRADIA_DASHBOARD_URL = "https://gradia.test"
  twilio.tokens.set(MASTER.sid, MASTER.token)
  vi.stubGlobal("fetch", vi.fn(fakeTwilio))
  ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
  db = serviceClient()
})
afterAll(async () => {
  if (!INTEGRATION) return
  vi.unstubAllGlobals()
  for (const s of shops) await cleanup(db, s)
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
beforeEach(() => {
  twilio.provisions = 0; twilio.releases = []; twilio.calls = []
  twilio.failLookup = false; twilio.loseProvisionResponse = false; twilio.provisionDelay = 0
  process.env.TWILIO_PILOT_SHOP_NUMBERS = ""
})

describe.skipIf(!INTEGRATION_WITH_SESSION)("I1: shops.twilio_phone_number is server-written", () => {
  const password = "Synthetic-" + hex(8)
  let owner: Seeded
  let session: SupabaseClient

  beforeAll(async () => {
    owner = await seedShop(db, { password }); shops.push(owner)
    session = await ownerSessionClient(owner.email, password)
  })

  it("a signed-in owner can't set, change or clear the number; other fields still save", async () => {
    const set = await session.from("shops").update({ twilio_phone_number: e164() }).eq("id", owner.shopId)
    expect(set.error?.code).toBe("42501")
    expect((await storedNumber(owner.shopId)).twilio_phone_number).toBeNull()

    const number = e164()
    expect((await db.from("shops").update({ twilio_phone_number: number }).eq("id", owner.shopId)).error).toBeNull()
    for (const value of [e164(), null]) {
      const res = await session.from("shops").update({ twilio_phone_number: value }).eq("id", owner.shopId)
      expect(res.error?.code).toBe("42501")
    }
    expect((await storedNumber(owner.shopId)).twilio_phone_number).toBe(number)

    // Writing the same value is not a change, and unrelated columns still save.
    expect((await session.from("shops").update({ name: "Renamed Fictional Shop", twilio_phone_number: number }).eq("id", owner.shopId)).error).toBeNull()
    expect((await session.from("shops").update({ name: "Fictional Shop" }).eq("id", owner.shopId)).error).toBeNull()
  })

  it("a signed-in owner can't create a shop that already carries a number", async () => {
    const res = await session.from("shops").insert({ name: "Fictional Second Shop", owner_id: owner.ownerId, twilio_phone_number: e164() })
    expect(res.error?.code).toBe("42501")
  })
})

describe.skipIf(!INTEGRATION)("I1: saving a number checks it's on the shop's own account", () => {
  let save: typeof import("@/lib/shop-texting-number").saveShopTextingNumber
  const BYO = { sid: "AC" + hex(16), token: "synthetic-byo-" + hex(8) }
  let byoNumber: string
  let masterNumber: string

  beforeAll(async () => {
    ;({ saveShopTextingNumber: save } = await import("@/lib/shop-texting-number"))
    twilio.tokens.set(BYO.sid, BYO.token)
    byoNumber = e164(); masterNumber = e164()
    twilio.numbers.set("PN" + hex(16), { sid: "PNbyo", phone_number: byoNumber, account: BYO.sid })
    twilio.numbers.set("PN" + hex(16), { sid: "PNmaster", phone_number: masterNumber, account: MASTER.sid })
  })
  const byoShop = async () => {
    const s = await seedShop(db); shops.push(s)
    expect((await db.from("shops").update({ twilio_account_sid_enc: encrypt(BYO.sid), twilio_auth_token_enc: encrypt(BYO.token) }).eq("id", s.shopId)).error).toBeNull()
    return s
  }

  it("a number on the shop's own Twilio account saves, asked with the shop's credentials only", async () => {
    const s = await byoShop()
    const res = await save({ db, shopId: s.shopId, value: byoNumber })
    expect(res).toMatchObject({ ok: true, via: "own_account" })
    expect((await storedNumber(s.shopId)).twilio_phone_number).toBe(byoNumber)
    expect(twilio.calls.length).toBeGreaterThan(0)
    expect(twilio.calls.every((c) => c.account === BYO.sid)).toBe(true)
    expect((await save({ db, shopId: s.shopId, value: null })).ok).toBe(true)
  })

  it("an unclaimed master-account number is refused for a shop with its own account, and nothing is stored", async () => {
    const s = await byoShop()
    expect(await save({ db, shopId: s.shopId, value: masterNumber })).toMatchObject({ ok: false, reason: "not_on_account" })
    expect((await storedNumber(s.shopId)).twilio_phone_number).toBeNull()
  })

  it("a shop without its own credentials can't claim a number, and Twilio isn't asked", async () => {
    const s = await seedShop(db); shops.push(s)
    expect(await save({ db, shopId: s.shopId, value: masterNumber })).toMatchObject({ ok: false, reason: "not_own_account" })
    expect(twilio.calls).toHaveLength(0)
    expect((await storedNumber(s.shopId)).twilio_phone_number).toBeNull()
  })

  it("a Twilio outage fails closed", async () => {
    const s = await byoShop()
    twilio.failLookup = true
    expect(await save({ db, shopId: s.shopId, value: byoNumber })).toMatchObject({ ok: false, reason: "lookup_failed" })
    expect((await storedNumber(s.shopId)).twilio_phone_number).toBeNull()
  })

  it("the shop's Gradia number and its allowlisted pilot number save without a lookup; anything else doesn't", async () => {
    const s = await seedShop(db); shops.push(s)
    const gradia = e164(), pilot = e164()
    expect((await db.from("shops").update({ gradia_number_e164: gradia }).eq("id", s.shopId)).error).toBeNull()
    expect(await save({ db, shopId: s.shopId, value: gradia })).toMatchObject({ ok: true, via: "gradia" })
    process.env.TWILIO_PILOT_SHOP_NUMBERS = `${s.shopId}=${pilot}`
    expect(await save({ db, shopId: s.shopId, value: pilot })).toMatchObject({ ok: true, via: "pilot" })
    expect(await save({ db, shopId: s.shopId, value: masterNumber })).toMatchObject({ ok: false, reason: "not_own_account" })
    expect(await save({ db, shopId: s.shopId, value: "5035550100" })).toMatchObject({ ok: false, reason: "invalid" })
    expect(twilio.calls).toHaveLength(0)
    expect((await storedNumber(s.shopId)).twilio_phone_number).toBe(pilot)
  })
})

describe.skipIf(!INTEGRATION)("R8: number purchase is single-flight", () => {
  let purchase: typeof import("@/lib/telephony-provider").purchaseNumber
  let ensureSubaccount: typeof import("@/lib/telephony-provider").ensureSubaccount
  beforeAll(async () => {
    ;({ purchaseNumber: purchase, ensureSubaccount } = await import("@/lib/telephony-provider"))
  })

  /** withSubaccount: create it first, so concurrent purchases race only on
   *  the number (#87's tests cover the subaccount race). */
  async function shop(opts: { withSubaccount?: boolean } = {}) {
    const s = await seedShop(db); shops.push(s)
    expect((await db.from("shops").update({ plan: "active" }).eq("id", s.shopId)).error).toBeNull()
    let row = (await db.from("shops").select("*").eq("id", s.shopId).single()).data!
    if (opts.withSubaccount) {
      await ensureSubaccount(db, row as Parameters<typeof ensureSubaccount>[1])
      row = (await db.from("shops").select("*").eq("id", s.shopId).single()).data!
    }
    return { s, row }
  }
  const buy = (row: Record<string, unknown>, number: string, client: SupabaseClient = db) =>
    purchase({ supabase: client, shop: row as Parameters<typeof purchase>[0]["shop"], e164: number, origin: "https://gradia.test" })
  const metered = async (shopId: string) =>
    (await db.from("usage_events").select("vendor_ref").eq("shop_id", shopId).eq("kind", "number_monthly")).data!
  const subaccountOf = async (shopId: string) =>
    (await db.from("shops").select("twilio_subaccount_sid").eq("id", shopId).single()).data!.twilio_subaccount_sid as string

  // Each concurrent caller either gets the stored number or is told a
  // purchase is in progress (the purchase claim, migration 20261020120000).
  const settledOn = (results: { ok: boolean }[], e164: string | null) => {
    for (const r of results) {
      if (r.ok) expect(r).toMatchObject({ e164 })
      else expect(r).toMatchObject({ error: expect.stringContaining("already in progress") })
    }
    expect(results.some((r) => r.ok)).toBe(true)
  }

  it("concurrent purchases of different numbers buy one number, stored and metered once", async () => {
    const { s, row } = await shop({ withSubaccount: true })
    twilio.provisionDelay = 250
    const results = await Promise.all(Array.from({ length: 4 }, () => buy(row, e164())))
    const stored = await storedNumber(s.shopId)
    expect(stored.gradia_number_e164).toBeTruthy()
    expect(stored.twilio_phone_number).toBe(stored.gradia_number_e164)
    settledOn(results, stored.gradia_number_e164)
    expect(twilio.provisions).toBe(1)
    expect(onAccount(await subaccountOf(s.shopId)).map((n) => n.sid)).toEqual([stored.gradia_number_sid])
    expect(twilio.releases).toHaveLength(0)
    expect((await metered(s.shopId)).map((u) => u.vendor_ref)).toEqual([stored.gradia_number_sid])
  })

  it("concurrent purchases of the same number buy it once and meter it once", async () => {
    const { s, row } = await shop({ withSubaccount: true })
    twilio.provisionDelay = 250
    const number = e164()
    const results = await Promise.all(Array.from({ length: 3 }, () => buy(row, number)))
    settledOn(results, number)
    expect(twilio.provisions).toBe(1)
    expect(twilio.releases).toHaveLength(0)
    expect(await metered(s.shopId)).toHaveLength(1)
  })

  it("a number whose save failed is adopted by the retry, not bought again, and metered once", async () => {
    const { s, row } = await shop()
    const failing = new Proxy(db, {
      get(target, key) {
        if (key !== "from") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v }
        return (table: string) => {
          const builder = target.from(table)
          if (table !== "shops") return builder
          const update = builder.update.bind(builder)
          ;(builder as unknown as { update: unknown }).update = (values: Record<string, unknown>, ...rest: unknown[]) => {
            const filter = (update as (...a: unknown[]) => unknown)(values, ...rest)
            if (!("gradia_number_e164" in values)) return filter
            ;(filter as unknown as { select: unknown }).select = () => ({
              then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "Synthetic write failure" } }).then(ok),
            })
            return filter
          }
          return builder
        }
      },
    })
    const first = await buy(row, e164(), failing)
    expect(first).toMatchObject({ ok: false })
    expect((await storedNumber(s.shopId)).gradia_number_e164).toBeNull()
    const sub = await subaccountOf(s.shopId)
    expect(onAccount(sub)).toHaveLength(1)
    expect(await metered(s.shopId)).toHaveLength(0)

    const retry = await buy(row, e164())
    expect(retry).toMatchObject({ ok: true, e164: onAccount(sub)[0].phone_number })
    expect(twilio.provisions).toBe(1)
    expect(twilio.releases).toHaveLength(0)
    expect((await metered(s.shopId)).map((u) => u.vendor_ref)).toEqual([onAccount(sub)[0].sid])
  })

  it("a provisioning response lost in transit is adopted, not bought again", async () => {
    const { s, row } = await shop()
    twilio.loseProvisionResponse = true
    const number = e164()
    expect(await buy(row, number)).toMatchObject({ ok: true, e164: number })
    expect(twilio.provisions).toBe(1)
    expect((await storedNumber(s.shopId)).gradia_number_e164).toBe(number)
    expect(await metered(s.shopId)).toHaveLength(1)
  })

  it("a stale snapshot doesn't buy a second number for a shop that already has one", async () => {
    const { s, row } = await shop()
    const number = e164()
    expect(await buy(row, number)).toMatchObject({ ok: true })
    twilio.calls = []
    expect(await buy(row, e164())).toMatchObject({ ok: true, e164: number }) // row still says no number
    expect(twilio.calls).toHaveLength(0)
    expect(await metered(s.shopId)).toHaveLength(1)
  })

  it("a subaccount holding more than one number is refused for reconciliation; nothing is bought", async () => {
    const { s, row } = await shop()
    expect(await buy(row, e164())).toMatchObject({ ok: true })
    const sub = await subaccountOf(s.shopId)
    twilio.numbers.set("PNextra", { sid: "PN" + hex(16), phone_number: e164(), account: sub })
    await db.from("shops").update({ gradia_number_e164: null, gradia_number_sid: null, twilio_phone_number: null }).eq("id", s.shopId)
    twilio.provisions = 0
    expect(await buy(row, e164())).toMatchObject({ ok: false, error: expect.stringContaining("more than one number") })
    expect(twilio.provisions).toBe(0)
  })
})
