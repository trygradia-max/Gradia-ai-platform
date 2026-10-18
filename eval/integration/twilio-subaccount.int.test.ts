import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"

// One Twilio subaccount per business, against real Postgres and a fake Twilio
// Accounts API (an in-memory store behind a stubbed fetch). Nothing reaches Twilio.

type FakeAccount = { sid: string; auth_token: string; friendly_name: string; status: string }
const twilio = { accounts: new Map<string, FakeAccount>(), creates: 0, closes: [] as string[] }
const sid = () => "AC" + randomBytes(16).toString("hex")

const realFetch = globalThis.fetch
function fakeTwilio(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  // Only the Twilio API is faked; the disposable database is reached for real.
  if (url.hostname !== "api.twilio.com") return realFetch(input, init)
  const method = (init?.method ?? "GET").toUpperCase()
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
  const one = url.pathname.match(/\/Accounts\/(AC[0-9a-f]{32})\.json$/)
  if (url.pathname.endsWith("/Accounts.json") && method === "POST") {
    twilio.creates += 1
    const name = new URLSearchParams(String(init?.body)).get("FriendlyName") ?? ""
    const account = { sid: sid(), auth_token: randomBytes(16).toString("hex"), friendly_name: name, status: "active" }
    twilio.accounts.set(account.sid, account)
    return json(account, 201)
  }
  if (url.pathname.endsWith("/Accounts.json") && method === "GET") {
    const name = url.searchParams.get("FriendlyName"), status = url.searchParams.get("Status")
    return json({ accounts: [...twilio.accounts.values()].filter(a => a.friendly_name === name && (!status || a.status === status)) })
  }
  if (one && method === "GET") {
    const account = twilio.accounts.get(one[1])
    return account ? json(account) : json({ message: "not found" }, 404)
  }
  if (one && method === "POST") {
    const account = twilio.accounts.get(one[1])
    if (!account) return json({ message: "not found" }, 404)
    account.status = new URLSearchParams(String(init?.body)).get("Status") ?? account.status
    if (account.status === "closed") twilio.closes.push(account.sid)
    return json(account)
  }
  return json({ message: `unexpected ${method} ${url.pathname}` }, 500)
}

describe.skipIf(!INTEGRATION)("one Twilio subaccount per business", () => {
  let db: SupabaseClient
  let ensureSubaccount: typeof import("@/lib/telephony-provider").ensureSubaccount
  let decrypt: typeof import("@/lib/crypto").tryDecryptSecret
  const shops: Seeded[] = []
  const shop = async () => { const s = await seedShop(db); shops.push(s); return s }
  const active = (shopId: string) => [...twilio.accounts.values()].filter(a => a.friendly_name === shopId && a.status === "active")
  const stored = async (shopId: string) =>
    (await db.from("shops").select("twilio_subaccount_sid,twilio_subaccount_token_enc").eq("id", shopId).single()).data!
  const fields = (s: Seeded) => ({ id: s.shopId }) as Parameters<typeof ensureSubaccount>[1]

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.TWILIO_ACCOUNT_SID = "AC" + "0".repeat(32)
    process.env.TWILIO_AUTH_TOKEN = "synthetic-master-token"
    vi.stubGlobal("fetch", vi.fn(fakeTwilio))
    ;({ ensureSubaccount } = await import("@/lib/telephony-provider"))
    ;({ tryDecryptSecret: decrypt } = await import("@/lib/crypto"))
    db = serviceClient()
  })
  beforeEach(() => { twilio.creates = 0; twilio.closes = [] })
  afterAll(async () => { vi.unstubAllGlobals(); for (const s of shops) await cleanup(db, s) })

  it("the first purchase creates exactly one subaccount, named for the shop and stored encrypted; later calls reuse it", async () => {
    const s = await shop()
    const first = await ensureSubaccount(db, fields(s))
    const again = await ensureSubaccount(db, fields(s))
    expect(again).toEqual(first)
    expect(twilio.creates).toBe(1)
    expect(active(s.shopId).map(a => a.sid)).toEqual([first.accountSid])
    const row = await stored(s.shopId)
    expect(row.twilio_subaccount_sid).toBe(first.accountSid)
    expect(row.twilio_subaccount_token_enc).not.toContain(first.authToken)
    expect(decrypt(row.twilio_subaccount_token_enc)).toBe(first.authToken)
  })

  it("concurrent purchases end with one active subaccount; every duplicate is closed and every caller gets the winner", async () => {
    const s = await shop()
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureSubaccount(db, fields(s))))
    const winner = (await stored(s.shopId)).twilio_subaccount_sid
    expect(new Set(results.map(r => r.accountSid))).toEqual(new Set([winner]))
    expect(active(s.shopId).map(a => a.sid)).toEqual([winner])
    expect(twilio.closes).toHaveLength(twilio.creates - 1)
    expect(twilio.closes).not.toContain(winner)
  })

  it("a save that fails after Twilio created the subaccount is recovered on retry, with no second subaccount", async () => {
    const s = await shop()
    let failed = false
    const failingOnce = new Proxy(db, {
      get(target, key) {
        if (key !== "from") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v }
        return (table: string) => {
          const builder = target.from(table)
          if (table !== "shops" || failed) return builder
          const update = builder.update.bind(builder)
          ;(builder as unknown as { update: unknown }).update = (...args: Parameters<typeof update>) => {
            failed = true
            const filter = update(...args)
            ;(filter as unknown as { then: unknown }).then = (ok: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { message: "Synthetic write failure" } }).then(ok)
            return filter
          }
          return builder
        }
      },
    })
    await expect(ensureSubaccount(failingOnce, fields(s))).rejects.toThrow(/nothing extra will be created/)
    expect((await stored(s.shopId)).twilio_subaccount_sid).toBeNull()
    expect(active(s.shopId)).toHaveLength(1)
    const recovered = await ensureSubaccount(db, fields(s))
    expect(twilio.creates).toBe(1)
    expect(recovered.accountSid).toBe(active(s.shopId)[0].sid)
    expect((await stored(s.shopId)).twilio_subaccount_sid).toBe(recovered.accountSid)
  })

  it("a stored subaccount whose token no longer decrypts keeps its SID; the token is recovered, never replaced by a new subaccount", async () => {
    const s = await shop()
    const original = await ensureSubaccount(db, fields(s))
    expect((await db.from("shops").update({ twilio_subaccount_token_enc: "not-a-valid-blob" }).eq("id", s.shopId)).error).toBeNull()
    twilio.creates = 0
    const recovered = await ensureSubaccount(db, fields(s))
    expect(recovered).toEqual(original)
    expect(twilio.creates).toBe(0)
    expect(decrypt((await stored(s.shopId)).twilio_subaccount_token_enc)).toBe(original.authToken)
  })

  it("a stored SID that belongs to another business is refused, and nothing is created", async () => {
    const a = await shop(), b = await shop()
    const theirs = await ensureSubaccount(db, fields(a))
    // A broken copy: b's row names a's subaccount but has no usable token. The
    // unique index keeps this from persisting, so simulate the read side only.
    expect((await db.from("shops").update({ twilio_subaccount_sid: null }).eq("id", a.shopId)).error).toBeNull()
    expect((await db.from("shops").update({ twilio_subaccount_sid: theirs.accountSid, twilio_subaccount_token_enc: null }).eq("id", b.shopId)).error).toBeNull()
    twilio.creates = 0
    await expect(ensureSubaccount(db, fields(b))).rejects.toThrow(/needs attention/)
    expect(twilio.creates).toBe(0)
    expect((await stored(b.shopId)).twilio_subaccount_token_enc).toBeNull()
  })

  it("two active subaccounts already named for one business stop the purchase for reconciliation", async () => {
    const s = await shop()
    for (let i = 0; i < 2; i++) {
      const account = { sid: sid(), auth_token: "t", friendly_name: s.shopId, status: "active" }
      twilio.accounts.set(account.sid, account)
    }
    await expect(ensureSubaccount(db, fields(s))).rejects.toThrow(/more than one phone account/)
    expect(twilio.creates).toBe(0)
    expect((await stored(s.shopId)).twilio_subaccount_sid).toBeNull()
  })

  it("the database refuses one subaccount on two businesses", async () => {
    const a = await shop(), b = await shop()
    const shared = sid()
    expect((await db.from("shops").update({ twilio_subaccount_sid: shared }).eq("id", a.shopId)).error).toBeNull()
    const second = await db.from("shops").update({ twilio_subaccount_sid: shared }).eq("id", b.shopId)
    expect(second.error?.code).toBe("23505")
  })
})
