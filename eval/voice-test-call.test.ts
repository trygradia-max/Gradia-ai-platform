import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Security audit run-1, finding #6. Nothing here contacts Vapi, Twilio or Supabase: the provider
 * call is a mock and the "database" is an in-memory fake whose claim RPC mirrors
 * `voice_test_call_claim` (the real SQL is exercised in eval/integration/voice-test-call.int.test.ts).
 */

const h = vi.hoisted(() => ({
  createOutboundCall: vi.fn(),
  service: null as unknown,
  session: { userId: "user-a", shopId: "shop-a" },
  revalidate: vi.fn(),
}))

vi.mock("@/lib/vapi", async (orig) => ({
  ...(await orig<typeof import("@/lib/vapi")>()),
  createOutboundCall: h.createOutboundCall,
}))
vi.mock("@/lib/shop", () => ({
  requireUser: async () => ({ id: h.session.userId }),
  requireShop: async () => ({ id: h.session.shopId, name: "Shop" }),
  getOptionalShop: async () => ({ id: h.session.shopId, name: "Shop" }),
}))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => h.service }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.service }))
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

import { requestVoiceTestCall, getVoiceTestCallState } from "@/app/actions/voice-builder"
import {
  VOICE_TEST_CALL_LIMITS,
  getVoiceTestCallPreflight,
  runVoiceTestCall,
  verifiedPhoneFromAuthUser,
  type VoiceTestCallDeps,
} from "@/lib/voice-test-call"

// ---------- in-memory fake ----------

type Row = Record<string, unknown>
type Db = {
  shops: Row[]
  usage_events: Row[]
  credit_grants: Row[]
  voice_test_call_attempts: Row[]
  authUsers: Record<string, Row | null>
  failTable?: string
  clock: number
  /** Runs after the claim row is inserted and before the claim returns — "time passes". */
  afterClaim?: () => void
}

function builder(db: Db, table: keyof Omit<Db, "authUsers" | "failTable" | "clock" | "afterClaim">) {
  const filters: ((r: Row) => boolean)[] = []
  let patch: Row | null = null
  const run = () => {
    if (db.failTable === table) return { data: null, error: { message: "boom" } }
    const rows = (db[table] as Row[]).filter((r) => filters.every((f) => f(r)))
    if (patch) {
      for (const r of rows) Object.assign(r, patch)
      return { data: null, error: null }
    }
    return { data: rows.map((r) => ({ ...r })), error: null }
  }
  const api: Record<string, unknown> = {
    select: () => api,
    update: (p: Row) => ((patch = p), api),
    eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), api),
    gte: (col: string, v: string) => (filters.push((r) => String(r[col]) >= v), api),
    maybeSingle: async () => {
      const res = run()
      return { data: (res.data as Row[] | null)?.[0] ?? null, error: res.error }
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  }
  return api
}

function claimRpc(db: Db, a: Record<string, number | string>) {
  const shop = db.shops.find((s) => s.id === a.p_shop_id && s.owner_id === a.p_user_id)
  if (!shop) return { ok: false, reason: "not_found" }
  if (shop.plan !== "active" || shop.voice_addon !== true) return { ok: false, reason: "not_entitled" }
  const mine = db.voice_test_call_attempts.filter((r) => r.shop_id === a.p_shop_id)
  const age = (r: Row) => (db.clock - (r.at as number)) / 1000
  if (mine.some((r) => r.status === "claimed" && age(r) < (a.p_inflight_seconds as number))) return { ok: false, reason: "in_progress" }
  if (mine.some((r) => age(r) < (a.p_min_interval_seconds as number))) return { ok: false, reason: "too_soon" }
  if (mine.filter((r) => age(r) < 3600).length >= (a.p_hour_limit as number) || mine.filter((r) => age(r) < 86400).length >= (a.p_day_limit as number)) {
    return { ok: false, reason: "rate_limited" }
  }
  const id = `attempt-${db.voice_test_call_attempts.length + 1}`
  db.voice_test_call_attempts.push({ id, shop_id: a.p_shop_id, status: "claimed", at: db.clock })
  db.afterClaim?.()
  return { ok: true, attempt_id: id }
}

const VERIFIED = "+16175550142"
const authUser = (over: Row = {}): Row => ({ phone: "16175550142", phone_confirmed_at: "2026-11-01T00:00:00Z", ...over })

function makeDb(shop: Row = {}): Db {
  return {
    shops: [
      {
        id: "shop-a", owner_id: "user-a", plan: "active", voice_addon: true, voice_minutes_budget: null,
        vapi_assistant_id: "asst_1", vapi_phone_number_id: "pn_1", vapi_stale: false,
        gradia_number_e164: "+16175550999", phone: "+19005550100", voice_test_called_at: null,
        voice_config: { escalation_phone: "+19005550101" }, ...shop,
      },
      { id: "shop-b", owner_id: "user-b", plan: "active", voice_addon: true, voice_minutes_budget: null,
        vapi_assistant_id: "asst_b", vapi_phone_number_id: "pn_b", vapi_stale: false, gradia_number_e164: "+16175550888" },
    ],
    usage_events: [], credit_grants: [], voice_test_call_attempts: [],
    authUsers: { "user-a": authUser(), "user-b": authUser({ phone: "12125550111" }) },
    clock: Date.parse("2026-11-12T12:00:00Z"),
  }
}

function fakeService(db: Db) {
  return {
    from: (t: string) => builder(db, t as never),
    rpc: async (name: string, args: Record<string, number | string>) => {
      if (name !== "voice_test_call_claim") throw new Error(`unexpected rpc ${name}`)
      return { data: claimRpc(db, args), error: null }
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          if (db.failTable === "auth") return { data: { user: null }, error: { message: "down" } }
          return { data: { user: db.authUsers[id] ?? null }, error: null }
        },
      },
    },
  }
}

let db: Db
const depsFor = (): VoiceTestCallDeps => {
  const service = fakeService(db) as never
  return {
    service,
    getAuthUser: async (id) => {
      const { data, error } = await (service as ReturnType<typeof fakeService>).auth.admin.getUserById(id)
      if (error) throw error
      return data.user as never
    },
    placeCall: h.createOutboundCall,
    now: () => new Date(db.clock),
  }
}
const run = (who = { userId: "user-a", shopId: "shop-a" }) => runVoiceTestCall(who, depsFor())

beforeEach(() => {
  h.createOutboundCall.mockReset()
  h.createOutboundCall.mockResolvedValue({ callId: "call_1" })
  h.revalidate.mockReset()
  h.session = { userId: "user-a", shopId: "shop-a" }
  db = makeDb()
  h.service = fakeService(db)
})

const refused = async (reason: string) => {
  const res = await run()
  expect(res).toMatchObject({ ok: false, reason })
  expect(h.createOutboundCall).not.toHaveBeenCalled()
}

// ---------- destination ownership ----------

describe("verified destination", () => {
  it("rings only the signed-in owner's confirmed auth phone, normalised to E.164", async () => {
    expect(await run()).toEqual({ ok: true })
    expect(h.createOutboundCall).toHaveBeenCalledTimes(1)
    expect(h.createOutboundCall).toHaveBeenCalledWith({ assistantId: "asst_1", phoneNumberId: "pn_1", toNumber: VERIFIED })
    expect(db.shops[0].voice_test_called_at).toBeTruthy()
    expect(db.voice_test_call_attempts[0]).toMatchObject({ status: "dispatched" })
  })

  it("the action takes no destination: arbitrary numbers in the arguments are ignored", async () => {
    expect(requestVoiceTestCall.length).toBe(0)
    const sneaky = requestVoiceTestCall as unknown as (a: unknown) => ReturnType<typeof requestVoiceTestCall>
    expect(await sneaky({ toNumber: "+19005551234", to: "+19005551234", shopId: "shop-b" })).toEqual({ ok: true })
    expect(h.createOutboundCall).toHaveBeenCalledTimes(1)
    expect(h.createOutboundCall.mock.calls[0][0].toNumber).toBe(VERIFIED)
    expect(h.revalidate).toHaveBeenCalledWith("/settings")
  })

  it.each([
    ["no phone on the account", null],
    ["a phone that was never confirmed", authUser({ phone_confirmed_at: null })],
    ["an unparseable confirmation", authUser({ phone_confirmed_at: "never" })],
    ["no auth user at all", null],
    ["a non-US number", authUser({ phone: "447700900123" })],
    ["a premium NANP prefix shape (area code starts with 0/1)", authUser({ phone: "10015550142" })],
    ["a short number", authUser({ phone: "1617555" })],
    ["a number with junk characters", authUser({ phone: "1617555014x" })],
  ])("refuses with %s, even when shops.phone and the escalation phone are set", async (_n, user) => {
    db.authUsers["user-a"] = user as Row | null
    await refused("no_verified_phone")
    expect(db.voice_test_call_attempts).toHaveLength(0)
  })

  it("never treats the owner-editable shop phone or escalation phone as proof", async () => {
    db.authUsers["user-a"] = null
    db.shops[0].phone = VERIFIED
    ;(db.shops[0].voice_config as Row).escalation_phone = VERIFIED
    await refused("no_verified_phone")
  })

  it("refuses to ring the shop's own Gradia number (a self-call loop)", async () => {
    db.authUsers["user-a"] = authUser({ phone: "16175550999" })
    await refused("no_verified_phone")
  })

  it("fails closed when Supabase Auth is unavailable", async () => {
    db.failTable = "auth"
    await refused("unavailable")
  })

  it("verifiedPhoneFromAuthUser accepts +1 and bare forms and nothing else", () => {
    expect(verifiedPhoneFromAuthUser({ phone: "+16175550142", phone_confirmed_at: "2026-11-01T00:00:00Z" })).toBe(VERIFIED)
    expect(verifiedPhoneFromAuthUser({ phone: "16175550142", phone_confirmed_at: "2026-11-01T00:00:00Z" })).toBe(VERIFIED)
    expect(verifiedPhoneFromAuthUser({ phone: "6175550142", phone_confirmed_at: "2026-11-01T00:00:00Z" })).toBeNull()
    expect(verifiedPhoneFromAuthUser({ phone: "", phone_confirmed_at: "2026-11-01T00:00:00Z" })).toBeNull()
  })
})

// ---------- entitlement, readiness, budget ----------

describe("entitlement and readiness", () => {
  it.each([
    ["free", { plan: "free", voice_addon: true }],
    ["past_due", { plan: "past_due", voice_addon: true }],
    ["cancelled add-on", { plan: "active", voice_addon: false }],
    ["free with no add-on", { plan: "free", voice_addon: false }],
  ])("refuses a %s shop", async (_n, patch) => {
    Object.assign(db.shops[0], patch)
    await refused("not_entitled")
    expect(db.voice_test_call_attempts).toHaveLength(0)
  })

  it.each([
    ["no assistant", { vapi_assistant_id: null }],
    ["no connected Vapi number", { vapi_phone_number_id: null }],
    ["no server-written Gradia number", { gradia_number_e164: null }],
  ])("refuses when %s", async (_n, patch) => {
    Object.assign(db.shops[0], patch)
    await refused("not_ready")
  })

  it("refuses a stale assistant", async () => {
    db.shops[0].vapi_stale = true
    await refused("stale")
  })
})

describe("voice minute budget", () => {
  const month = "2026-11-03T00:00:00Z"
  it("refuses once the month's allowance (60 included) is used", async () => {
    db.usage_events.push({ shop_id: "shop-a", kind: "voice_minute", quantity: 60, created_at: month })
    await refused("budget_exhausted")
  })
  it("a purchased minute pack extends the allowance", async () => {
    db.usage_events.push({ shop_id: "shop-a", kind: "voice_minute", quantity: 60, created_at: month })
    db.credit_grants.push({ shop_id: "shop-a", minutes: 40, created_at: month })
    expect(await run()).toEqual({ ok: true })
  })
  it("honours the owner's lower cap", async () => {
    db.shops[0].voice_minutes_budget = 5
    db.usage_events.push({ shop_id: "shop-a", kind: "voice_minute", quantity: 5, created_at: month })
    await refused("budget_exhausted")
  })
  it("fails closed when the usage read errors (the webhook read fails open; this one must not)", async () => {
    db.failTable = "usage_events"
    await refused("budget_exhausted")
  })
  it("fails closed when the grants read errors", async () => {
    db.failTable = "credit_grants"
    await refused("budget_exhausted")
  })
})

// ---------- tenancy ----------

describe("cross-tenant attempts", () => {
  it("a user cannot run a test call for a shop they do not own", async () => {
    expect(await run({ userId: "user-b", shopId: "shop-a" })).toMatchObject({ ok: false, reason: "not_found" })
    expect(await run({ userId: "user-a", shopId: "shop-b" })).toMatchObject({ ok: false, reason: "not_found" })
    expect(h.createOutboundCall).not.toHaveBeenCalled()
    expect(db.voice_test_call_attempts).toHaveLength(0)
  })

  it("the action derives the shop from the owner session, never from input", async () => {
    h.session = { userId: "user-b", shopId: "shop-b" }
    expect(await requestVoiceTestCall()).toEqual({ ok: true })
    expect(h.createOutboundCall.mock.calls[0][0]).toMatchObject({ assistantId: "asst_b", phoneNumberId: "pn_b", toNumber: "+12125550111" })
    expect(db.voice_test_call_attempts.map((a) => a.shop_id)).toEqual(["shop-b"])
  })

  it("never rings user B's verified phone for user A's shop", async () => {
    await run()
    expect(h.createOutboundCall.mock.calls.map((c) => c[0].toNumber)).toEqual([VERIFIED])
  })
})

// ---------- replay / concurrency / rate ----------

describe("rate and concurrency", () => {
  it("five simultaneous requests place exactly one call", async () => {
    const results = await Promise.all([run(), run(), run(), run(), run()])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(h.createOutboundCall).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && ["in_progress", "too_soon"].includes(r.reason))).toBe(true)
  })

  it("an immediate replay is refused; after the interval it is allowed", async () => {
    expect(await run()).toEqual({ ok: true })
    expect(await run()).toMatchObject({ ok: false, reason: "too_soon" })
    db.clock += (VOICE_TEST_CALL_LIMITS.minIntervalSeconds + 1) * 1000
    expect(await run()).toEqual({ ok: true })
    expect(h.createOutboundCall).toHaveBeenCalledTimes(2)
  })

  it("caps attempts per hour and per day", async () => {
    for (let i = 0; i < VOICE_TEST_CALL_LIMITS.perHour; i++) {
      expect(await run()).toEqual({ ok: true })
      db.clock += 61_000
    }
    expect(await run()).toMatchObject({ ok: false, reason: "rate_limited" })
    expect(h.createOutboundCall).toHaveBeenCalledTimes(VOICE_TEST_CALL_LIMITS.perHour)
    db.clock += 3_600_000
    for (let i = 0; i < VOICE_TEST_CALL_LIMITS.perDay - VOICE_TEST_CALL_LIMITS.perHour; i++) {
      expect(await run()).toEqual({ ok: true })
      db.clock += 61_000
      if ((i + 1) % VOICE_TEST_CALL_LIMITS.perHour === 0) db.clock += 3_600_000
    }
    expect(await run()).toMatchObject({ ok: false, reason: "rate_limited" })
  })

  it("failed provider calls still count toward the ceiling", async () => {
    h.createOutboundCall.mockRejectedValue(new Error("vapi down"))
    const first = await run()
    expect(first).toMatchObject({ ok: false, reason: "provider_failed" })
    expect(db.voice_test_call_attempts[0]).toMatchObject({ status: "failed" })
    expect(db.shops[0].voice_test_called_at).toBeNull()
    expect(await run()).toMatchObject({ ok: false, reason: "too_soon" })
  })

  it("a failed claim RPC fails closed", async () => {
    const deps = depsFor()
    deps.service = { ...(deps.service as object), rpc: async () => ({ data: null, error: { message: "x" } }) } as never
    expect(await runVoiceTestCall({ userId: "user-a", shopId: "shop-a" }, deps)).toMatchObject({ ok: false, reason: "unavailable" })
    expect(h.createOutboundCall).not.toHaveBeenCalled()
  })

  it("a malformed claim response fails closed", async () => {
    for (const data of [{ ok: true }, { ok: true, attempt_id: "" }, { ok: "yes" }, "ok", { ok: false, reason: "surprise" }]) {
      const deps = depsFor()
      deps.service = { ...(deps.service as object), rpc: async () => ({ data, error: null }) } as never
      expect(await runVoiceTestCall({ userId: "user-a", shopId: "shop-a" }, deps)).toMatchObject({ ok: false })
    }
    expect(h.createOutboundCall).not.toHaveBeenCalled()
  })
})

// ---------- recheck immediately before the provider call ----------

describe("recheck after the claim", () => {
  const raced = async (mutate: () => void, reason: string) => {
    db.afterClaim = mutate
    expect(await run()).toMatchObject({ ok: false, reason })
    expect(h.createOutboundCall).not.toHaveBeenCalled()
    expect(db.voice_test_call_attempts[0]).toMatchObject({ status: "aborted" })
    expect(db.shops[0].voice_test_called_at).toBeNull()
  }
  it("catches a cancellation that lands after the first check", () =>
    raced(() => { db.shops[0].voice_addon = false }, "not_entitled"))
  it("catches the plan going past_due", () => raced(() => { db.shops[0].plan = "past_due" }, "not_entitled"))
  it("catches the budget being exhausted", () =>
    raced(() => { db.usage_events.push({ shop_id: "shop-a", kind: "voice_minute", quantity: 60, created_at: "2026-11-12T11:59:00Z" }) }, "budget_exhausted"))
  it("catches the assistant going stale", () => raced(() => { db.shops[0].vapi_stale = true }, "stale"))
  it("catches the verified phone being removed", () => raced(() => { db.authUsers["user-a"] = authUser({ phone_confirmed_at: null }) }, "no_verified_phone"))
  it("catches the verified phone changing to another number", () =>
    raced(() => { db.authUsers["user-a"] = authUser({ phone: "12125550111" }) }, "no_verified_phone"))
})

// ---------- UI state ----------

describe("test-call state for the UI", () => {
  it("explains that verification is required when there is no confirmed phone", async () => {
    db.authUsers["user-a"] = authUser({ phone_confirmed_at: null })
    const state = await getVoiceTestCallPreflight({ userId: "user-a", shopId: "shop-a" }, depsFor())
    expect(state).toMatchObject({ available: false, reason: "no_verified_phone" })
    expect((state as { message: string }).message).toMatch(/verified/i)
    expect(h.createOutboundCall).not.toHaveBeenCalled()
  })

  it("exposes only a masked number, never the destination", async () => {
    const state = await getVoiceTestCallPreflight({ userId: "user-a", shopId: "shop-a" }, depsFor())
    expect(state).toEqual({ available: true, maskedPhone: "+1 ••• ••• 0142" })
    expect(JSON.stringify(state)).not.toContain("6175550142")
  })

  it("the server action reads the owner's session shop", async () => {
    expect(await getVoiceTestCallState()).toMatchObject({ available: true })
    h.session = { userId: "user-a", shopId: "shop-b" }
    expect(await getVoiceTestCallState()).toMatchObject({ available: false, reason: "not_found" })
    expect(h.createOutboundCall).not.toHaveBeenCalled()
  })
})

// ---------- structural locks ----------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe("structural locks", () => {
  const files = walk("src")
  const users = (needle: string) => files.filter((f) => readFileSync(f, "utf8").includes(needle)).sort()

  it("only the guard module mints a test-call authorization", () => {
    expect(users("mintVoiceTestCallAuthorization")).toEqual([
      "src/lib/voice-test-call-authorization.ts",
      "src/lib/voice-test-call.ts",
    ])
  })

  it("only the provider seam calls the outbound-call endpoint, and only startVoiceTestCall uses it", () => {
    expect(users("createOutboundCall")).toEqual(["src/lib/vapi.ts", "src/lib/voice-provider.ts"])
    expect(users("startVoiceTestCall(")).toEqual(["src/lib/voice-provider.ts", "src/lib/voice-test-call.ts"])
  })

  it("the action and the card have no destination input", () => {
    const action = readFileSync("src/app/actions/voice-builder.ts", "utf8")
    const card = readFileSync("src/components/gradia/voice-builder-card.tsx", "utf8")
    expect(action).not.toMatch(/testCallSchema|toNumber/)
    expect(card).not.toMatch(/testNumber|setTestNumber|toNumber|Your phone number for the test call/)
    expect(card).toContain("requestVoiceTestCall()")
  })
})
