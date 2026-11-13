import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  bindCaller,
  CALLER_IDENTITY_REFUSAL,
  describeCallerIdentity,
  trustedCallerPhone,
} from "@/lib/voice-caller-identity"
import { VOICE_TOOL_DEFINITIONS as VAPI_TOOL_DEFINITIONS } from "@/lib/voice-provider"
import {
  cancelAppointment,
  captureLead,
  lookupCustomerHistory,
  proposeBooking,
  proposeQuote,
  rescheduleAppointment,
} from "@/lib/vapi-tools"

/**
 * Security-audit run-1 findings #4, #9, #10 — voice caller identity.
 *
 * A caller must never read or stage actions against another customer by
 * getting the model to pass a different phone number. Customer-bound tools
 * are bound to the authenticated telephony caller ID (call.customer.number);
 * a supplied phone can only agree with it. Everything below runs the REAL
 * handlers and webhook route against a stateful, shop-scoped in-memory
 * database, so "no data leaked" is observed in the spoken reply, in the
 * staged rows, and in which customer the handlers queried.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => db.client(),
}))
vi.mock("@/lib/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/availability")>()),
  stagingAvailability: vi.fn(async () => ({
    summary: null,
    blocking: [],
    failure: null,
  })),
}))
vi.mock("@/lib/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory")>()),
  recentChannelActivity: vi.fn(async () => []),
}))
vi.mock("@/lib/call-records", () => ({ persistCallRecord: vi.fn(async () => {}) }))
vi.mock("@/lib/credits", () => ({ recordUsage: vi.fn(async () => "written") }))
vi.mock("@/lib/pricing", () => ({
  getPricing: vi.fn(async () => ({})),
  priceUsage: vi.fn(() => ({ wholesale_cost: 0, retail_cost: 0 })),
}))
vi.mock("@/lib/provider-events", () => ({
  claimProviderEvent: vi.fn(),
  completeProviderEvent: vi.fn(),
  failProviderEvent: vi.fn(),
}))
vi.mock("@/lib/voice-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice-provider")>()),
  voiceBudgetState: vi.fn(),
}))

type Row = Record<string, unknown>

/** Filtering, shop-scoped fake. Writes other than INSERT are forbidden:
 *  voice handlers stage approvals; executors write on approve. */
const db = {
  tables: {} as Record<string, Row[]>,
  inserts: [] as { table: string; row: Row }[],
  reset(seed: Record<string, Row[]>) {
    this.tables = JSON.parse(JSON.stringify(seed))
    this.inserts = []
  },
  staged(): Row[] {
    return this.inserts.filter((i) => i.table === "pending_actions").map((i) => i.row)
  },
  client() {
    const self: typeof db = db
    const from = (table: string) => {
      const filters: ((r: Row) => boolean)[] = []
      let sort: { col: string; asc: boolean } | null = null
      let max = Infinity
      const rows = () => {
        let out = (self.tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
        if (sort) {
          const { col, asc } = sort
          out = [...out].sort((a, b) =>
            String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0
          )
        }
        return out.slice(0, max)
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => (filters.push((r) => r[col] === val), b)
      b.gte = (col: string, val: string) => (filters.push((r) => String(r[col]) >= val), b)
      b.or = (expr: string) => {
        const alts = expr.split(",").map((p) => {
          const [col, , val] = p.split(".")
          return (r: Row) => r[col] === val
        })
        filters.push((r) => alts.some((f) => f(r)))
        return b
      }
      b.order = (col: string, o?: { ascending?: boolean }) => ((sort = { col, asc: o?.ascending !== false }), b)
      b.limit = (n: number) => ((max = n), b)
      b.maybeSingle = async () => {
        const r = rows()
        return r.length > 1
          ? { data: null, error: { message: "multiple rows" } }
          : { data: r[0] ?? null, error: null }
      }
      b.single = async () => ({ data: rows()[0] ?? null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null })
      b.insert = (row: Row) => {
        self.inserts.push({ table, row })
        const res = { data: { id: `${table}-${self.inserts.length}` }, error: null }
        const ins: Record<string, unknown> = {
          select: () => ({ single: async () => res }),
          then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
        }
        return ins
      }
      b.update = () => {
        throw new Error(`handler must not UPDATE ${table}`)
      }
      b.delete = () => {
        throw new Error(`handler must not DELETE from ${table}`)
      }
      return b
    }
    return { from, rpc: async () => ({ data: null, error: null }) }
  },
}

// ── fixtures ────────────────────────────────────────────────────────────────
const SHOP_A = "shop-a"
const SHOP_B = "shop-b"
const ALICE = "+16175550142" // the legitimate caller (shop A)
const VICTIM = "+15035550199" // another customer of shop A
const OUTSIDER = "+14155550123" // customer of shop B only
const SHOP_LINE = "+16175550100" // the shop's own dialed number
const FUTURE = new Date(Date.now() + 5 * 864e5).toISOString()
const LATER = new Date(Date.now() + 9 * 864e5).toISOString()

const SEED: Record<string, Row[]> = {
  shops: [
    { id: SHOP_A, owner_id: "owner-a", vapi_assistant_id: "asst-a", vapi_server_secret_enc: null },
    { id: SHOP_B, owner_id: "owner-b", vapi_assistant_id: "asst-b", vapi_server_secret_enc: null },
  ],
  customers: [
    { id: "c-alice", shop_id: SHOP_A, name: "Alice Park", phone: ALICE, phone_canonical: ALICE, created_at: "2026-01-01" },
    { id: "c-victim", shop_id: SHOP_A, name: "Vera Victim", phone: VICTIM, phone_canonical: VICTIM, created_at: "2026-01-02" },
    { id: "c-shopline", shop_id: SHOP_A, name: "Shop Line Holder", phone: SHOP_LINE, phone_canonical: SHOP_LINE, created_at: "2026-01-03" },
    { id: "c-outsider", shop_id: SHOP_B, name: "Olly Outsider", phone: OUTSIDER, phone_canonical: OUTSIDER, created_at: "2026-01-04" },
  ],
  appointments: [
    { id: "appt-victim", shop_id: SHOP_A, customer_id: "c-victim", scheduled_at: FUTURE, service_name: "Secret Ceramic Coating" },
    { id: "appt-alice", shop_id: SHOP_A, customer_id: "c-alice", scheduled_at: LATER, service_name: "Interior Detail" },
    { id: "appt-shopline", shop_id: SHOP_A, customer_id: "c-shopline", scheduled_at: FUTURE, service_name: "Shop Line Wash" },
    { id: "appt-outsider", shop_id: SHOP_B, customer_id: "c-outsider", scheduled_at: FUTURE, service_name: "Outsider PPF" },
  ],
  interactions: [
    { id: "i-victim", shop_id: SHOP_A, customer_id: "c-victim", channel: "sms", role: "customer", content: "VICTIM-PRIVATE-MESSAGE about my Porsche", occurred_at: "2026-02-01T00:00:00Z" },
    { id: "i-alice", shop_id: SHOP_A, customer_id: "c-alice", channel: "sms", role: "customer", content: "Alice asking about tint", occurred_at: "2026-02-02T00:00:00Z" },
    { id: "i-outsider", shop_id: SHOP_B, customer_id: "c-outsider", channel: "sms", role: "customer", content: "OUTSIDER-PRIVATE-MESSAGE", occurred_at: "2026-02-03T00:00:00Z" },
  ],
  services: [],
}

const LEAKS = ["Vera", "Victim", "VICTIM-PRIVATE", "Porsche", "Secret Ceramic", "Olly", "Outsider", "OUTSIDER-PRIVATE", "Shop Line"]

type Tool = (
  supabase: never,
  shopId: string,
  params: Record<string, unknown>,
  ctx: { id?: string; callerPhone?: string }
) => Promise<string>

const TOOLS: { name: string; fn: Tool; params: Record<string, unknown> }[] = [
  { name: "lookup_customer_history", fn: lookupCustomerHistory as Tool, params: {} },
  { name: "cancel_appointment", fn: cancelAppointment as Tool, params: { reason: "changed my mind" } },
  { name: "reschedule_appointment", fn: rescheduleAppointment as Tool, params: { new_when: "Friday at 3" } },
  { name: "propose_booking", fn: proposeBooking as Tool, params: { customer_name: "Pat", service: "Full Detail", when: "Friday at 10", iso_start_time: "2030-01-04T18:00:00Z" } },
  { name: "propose_quote", fn: proposeQuote as Tool, params: { customer_name: "Pat", services: ["Full Detail"] } },
  { name: "capture_lead", fn: captureLead as Tool, params: { customer_name: "Pat", service: "tint" } },
]

const run = (t: (typeof TOOLS)[number], extra: Record<string, unknown>, ctx: { id?: string; callerPhone?: string }, shop = SHOP_A) =>
  t.fn(db.client() as never, shop, { ...t.params, ...extra }, ctx)

beforeEach(() => {
  db.reset(SEED)
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

// ── identity primitive ──────────────────────────────────────────────────────
describe("trusted caller ID normalization", () => {
  it("normalizes formatted E.164 caller IDs", () => {
    expect(trustedCallerPhone({ callerPhone: "+1 (617) 555-0142" })).toBe(ALICE)
    expect(trustedCallerPhone({ callerPhone: " +1-617-555-0142 " })).toBe(ALICE)
  })

  it.each([undefined, "", "   ", "anonymous", "Anonymous", "restricted", "unknown", "blocked", "private", "6175550142", "+0123456789", "+1", "tel:+16175550142"])(
    "missing/blocked/invalid caller ID %j has no identity",
    (raw) => {
      expect(trustedCallerPhone({ callerPhone: raw })).toBeNull()
      expect(bindCaller({ callerPhone: raw, id: "c1" }, "").ok).toBe(false)
    }
  )
})

describe("bindCaller", () => {
  const ctx = { id: "call-1", callerPhone: ALICE }

  it("binds to the caller ID with no supplied phone", () => {
    const r = bindCaller(ctx, "")
    expect(r).toEqual({
      ok: true,
      phone: ALICE,
      evidence: { source: "vapi_call_customer_number", verified_phone: ALICE, supplied_phone: "not_supplied", call_id: "call-1" },
    })
  })

  it.each(["+16175550142", "+1 (617) 555-0142", "617-555-0142", "(617) 555 0142", "16175550142", "1 617 555 0142"])(
    "a supplied phone that normalizes to the caller ID (%s) agrees",
    (supplied) => {
      const r = bindCaller(ctx, supplied)
      expect(r.ok && r.evidence.supplied_phone).toBe("matched")
    }
  )

  it.each([
    ["another number", VICTIM],
    ["another number, national form", "503-555-0199"],
    ["off by one digit", "+16175550143"],
    ["caller ID plus a suffix", "+161755501420"],
    ["words around the number", "call me at +16175550142 or +15035550199"],
    ["injection-ish text", "+16175550142; DROP TABLE customers"],
    ["10 digits for a non-NANP caller", "7911123456"],
  ])("%s does not agree", (_label, supplied) => {
    expect(bindCaller(ctx, supplied)).toEqual({ ok: false, reason: "phone_mismatch" })
  })

  it("never guesses a country: a 10-digit national phone does not bind a non-+1 caller", () => {
    expect(bindCaller({ callerPhone: "+447911123456" }, "7911123456").ok).toBe(false)
  })

  it("a blocked caller ID refuses even when the model supplies a real-looking phone", () => {
    expect(bindCaller({ callerPhone: "anonymous" }, VICTIM)).toEqual({ ok: false, reason: "caller_id_unavailable" })
  })
})

// ── exploit regression: every customer-bound tool ───────────────────────────
describe.each(TOOLS)("$name — exploit regression", (tool) => {
  it("a model-supplied victim phone is refused: uniform reply, nothing read, nothing staged", async () => {
    const reply = await run(tool, { phone: VICTIM }, { id: "call-x", callerPhone: ALICE })
    expect(reply).toBe(CALLER_IDENTITY_REFUSAL)
    for (const leak of LEAKS) expect(reply).not.toContain(leak)
    expect(db.inserts).toHaveLength(0)
  })

  it.each(["phone", "caller_phone", "callerPhone", "to_phone"])(
    "victim phone under the alias key %s is refused too",
    async (key) => {
      const reply = await run(tool, { [key]: VICTIM }, { id: "call-x", callerPhone: ALICE })
      expect(reply).toBe(CALLER_IDENTITY_REFUSAL)
      expect(db.inserts).toHaveLength(0)
    }
  )

  it("missing, blocked or malformed caller ID is refused with the SAME reply, even with a phone argument", async () => {
    for (const callerPhone of [undefined, "", "anonymous", "restricted", "garbage"]) {
      for (const extra of [{}, { phone: VICTIM }, { phone: ALICE }]) {
        const reply = await run(tool, extra, { id: "call-y", callerPhone })
        expect(reply).toBe(CALLER_IDENTITY_REFUSAL)
      }
    }
    expect(db.inserts).toHaveLength(0)
  })

  it("does not fall back to the shop's own number (call.phoneNumber is not a caller)", async () => {
    // Even if a customer exists on the shop's own line, a call that carries no
    // caller ID must not resolve to it. (Route-level proof below.)
    const reply = await run(tool, {}, { id: "call-z", callerPhone: undefined })
    expect(reply).toBe(CALLER_IDENTITY_REFUSAL)
    expect(db.inserts).toHaveLength(0)
  })

  it("refusal is identical whether or not the targeted number belongs to a customer (no existence oracle)", async () => {
    const exists = await run(tool, { phone: VICTIM }, { id: "c", callerPhone: ALICE })
    const otherShopOnly = await run(tool, { phone: OUTSIDER }, { id: "c", callerPhone: ALICE })
    const nobody = await run(tool, { phone: "+19995550000" }, { id: "c", callerPhone: ALICE })
    expect(new Set([exists, otherShopOnly, nobody]).size).toBe(1)
  })

  it("replay: the same exploit repeated, or Alice's arguments replayed on another caller's call, never crosses over", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await run(tool, { phone: VICTIM }, { id: "call-r", callerPhone: ALICE })).toBe(CALLER_IDENTITY_REFUSAL)
    }
    expect(db.inserts).toHaveLength(0)

    // Alice's own arguments (phone = Alice) replayed on a call from the victim
    // are a mismatch on that call — they bind to nothing.
    expect(await run(tool, { phone: ALICE }, { id: "call-r2", callerPhone: VICTIM })).toBe(CALLER_IDENTITY_REFUSAL)
    expect(db.inserts).toHaveLength(0)
  })
})

// ── legitimate callers ──────────────────────────────────────────────────────
describe("legitimate caller", () => {
  const ctx = { id: "call-1", callerPhone: ALICE }

  it("history is the caller's own, queried by the caller's customer id only", async () => {
    const reply = await lookupCustomerHistory(db.client() as never, SHOP_A, {}, ctx)
    expect(reply).toContain("Alice Park")
    expect(reply).toContain("Alice asking about tint")
    for (const leak of LEAKS) expect(reply).not.toContain(leak)
  })

  it("formatted caller ID + national-form supplied phone still works", async () => {
    const reply = await lookupCustomerHistory(
      db.client() as never,
      SHOP_A,
      { phone: "617-555-0142" },
      { id: "c", callerPhone: "+1 (617) 555-0142" }
    )
    expect(reply).toContain("Alice Park")
  })

  it("no customer on file for this caller → first-time reply, not someone else's file", async () => {
    const reply = await lookupCustomerHistory(db.client() as never, SHOP_A, {}, { id: "c", callerPhone: "+12125550000" })
    expect(reply).toMatch(/first time/i)
    for (const leak of LEAKS) expect(reply).not.toContain(leak)
  })

  it("cancel / reschedule bind to the caller's OWN appointment, ignoring injected ids", async () => {
    await cancelAppointment(db.client() as never, SHOP_A, { appointment_id: "appt-victim", customer_id: "c-victim" }, ctx)
    await rescheduleAppointment(
      db.client() as never,
      SHOP_A,
      { new_when: "Monday", appointment_id: "appt-victim", customer_id: "c-victim" },
      ctx
    )
    const staged = db.staged()
    expect(staged.map((r) => r.action_type)).toEqual(["cancel_appointment", "reschedule_appointment"])
    for (const row of staged) {
      const p = row.payload as Row
      expect(p.appointment_id).toBe("appt-alice")
      expect(p.service).toBe("Interior Detail")
      expect(p.phone).toBe(ALICE)
    }
  })

  it("every staging tool persists the trusted caller identity and the CALLER ID as the phone", async () => {
    for (const t of TOOLS.filter((t) => t.name !== "lookup_customer_history")) {
      db.reset(SEED)
      await run(t, {}, ctx)
      const staged = db.staged()
      expect(staged, t.name).toHaveLength(1)
      expect(staged[0].shop_id).toBe(SHOP_A)
      const p = staged[0].payload as Row
      expect(p.phone, t.name).toBe(ALICE)
      expect(p.source).toBe("voice")
      expect(p.caller_identity, t.name).toEqual({
        source: "vapi_call_customer_number",
        verified_phone: ALICE,
        supplied_phone: "not_supplied",
        call_id: "call-1",
      })
      const decision = db.inserts.find((i) => i.table === "action_decisions")
      expect((decision?.row.inputs as Row).caller_id_verified, t.name).toBe(true)
    }
  })

  it("a matching supplied phone is recorded as matched; the staged phone is still the caller ID", async () => {
    await captureLead(db.client() as never, SHOP_A, { customer_name: "Pat", phone: "617-555-0142" }, ctx)
    const p = db.staged()[0].payload as Row
    expect(p.phone).toBe(ALICE)
    expect((p.caller_identity as Row).supplied_phone).toBe("matched")
  })

  it("a model-supplied caller_identity / source cannot forge the evidence", async () => {
    await captureLead(
      db.client() as never,
      SHOP_A,
      { customer_name: "Pat", caller_identity: { verified_phone: VICTIM }, vapi_call_id: "forged", source: "sms" },
      ctx
    )
    const p = db.staged()[0].payload as Row
    expect((p.caller_identity as Row).verified_phone).toBe(ALICE)
    expect(p.source).toBe("voice")
    expect(p.vapi_call_id).toBe("call-1")
    expect(JSON.stringify(p)).not.toContain(VICTIM)
  })

  it("other-tenant data never surfaces: a shop-B-only number looks like a stranger in shop A", async () => {
    const hist = await lookupCustomerHistory(db.client() as never, SHOP_A, {}, { id: "c", callerPhone: OUTSIDER })
    expect(hist).toMatch(/first time/i)
    expect(hist).not.toContain("Outsider")
    await cancelAppointment(db.client() as never, SHOP_A, {}, { id: "c", callerPhone: OUTSIDER })
    const p = db.staged()[0].payload as Row
    expect(p.appointment_id).toBeNull()
    expect(db.staged()[0].shop_id).toBe(SHOP_A)
  })

  it("missing required non-identity fields still asks instead of staging", async () => {
    const reply = await rescheduleAppointment(db.client() as never, SHOP_A, {}, ctx)
    expect(reply).toContain("new time")
    expect(db.inserts).toHaveLength(0)
  })

  it("handlers never update or delete (no-direct-write guarantee)", async () => {
    await cancelAppointment(db.client() as never, SHOP_A, {}, ctx) // update()/delete() would throw
    expect(db.staged()).toHaveLength(1)
  })
})

// ── tool schemas ────────────────────────────────────────────────────────────
describe("declared tool schemas", () => {
  it("no tool exposes a phone-like argument to the model", () => {
    for (const t of VAPI_TOOL_DEFINITIONS) {
      const props = Object.keys((t.function.parameters as { properties: Record<string, unknown> }).properties)
      expect(props.filter((k) => /phone|number/i.test(k)), t.function.name).toEqual([])
    }
  })

  it("the history tool says it is the caller's own", () => {
    const t = VAPI_TOOL_DEFINITIONS.find((x) => x.function.name === "lookup_customer_history")
    expect(t?.function.description).toMatch(/caller/i)
  })
})

// ── approval surface honesty ────────────────────────────────────────────────
describe("describeCallerIdentity (approval card evidence)", () => {
  const evidence = { source: "vapi_call_customer_number", verified_phone: ALICE, supplied_phone: "not_supplied", call_id: "c" }

  it("non-voice proposals say nothing", () => {
    expect(describeCallerIdentity({ source: "sms", phone: ALICE })).toBeNull()
    expect(describeCallerIdentity(null)).toBeNull()
  })

  it("voice + evidence → verified", () => {
    expect(describeCallerIdentity({ source: "voice", phone: ALICE, caller_identity: evidence })).toEqual({ kind: "verified", phone: ALICE })
    expect(describeCallerIdentity({ source: "voice", phone: "+1 (617) 555-0142", caller_identity: evidence })?.kind).toBe("verified")
  })

  it("owner edited the phone away from the caller ID → edited (never claims verified)", () => {
    expect(describeCallerIdentity({ source: "voice", phone: VICTIM, caller_identity: evidence })).toEqual({
      kind: "edited",
      callerId: ALICE,
      current: VICTIM,
    })
  })

  it("legacy voice proposal without evidence, or with forged/invalid evidence → unrecorded", () => {
    expect(describeCallerIdentity({ source: "voice", phone: ALICE })).toEqual({ kind: "unrecorded" })
    expect(describeCallerIdentity({ source: "voice", phone: ALICE, caller_identity: { ...evidence, source: "model" } })).toEqual({ kind: "unrecorded" })
    expect(describeCallerIdentity({ source: "voice", phone: ALICE, caller_identity: { ...evidence, verified_phone: "anonymous" } })).toEqual({ kind: "unrecorded" })
  })
})

// ── webhook route: trusted context only ─────────────────────────────────────
describe("Vapi webhook route — identity comes only from call.customer.number", () => {
  const SECRET = "test-secret"
  let POST: (r: Request) => Promise<Response>

  beforeEach(async () => {
    process.env.VAPI_WEBHOOK_SECRET = SECRET
    delete process.env.VAPI_DEFAULT_SHOP_ID
    ;({ POST } = await import("@/app/api/vapi/webhook/route"))
  })

  const post = (message: Record<string, unknown>, secret = SECRET) =>
    POST(
      new Request("https://app.test/api/vapi/webhook", {
        method: "POST",
        headers: { "x-vapi-secret": secret, "content-type": "application/json" },
        body: JSON.stringify({ message }),
      })
    )

  const toolCall = (name: string, args: Record<string, unknown>, call: Record<string, unknown>) => ({
    type: "tool-calls",
    call: { id: "call-route", assistantId: "asst-a", ...call },
    toolCallList: [{ id: "tc-1", function: { name, arguments: args } }],
  })

  it("tool-calls: a victim phone argument on Alice's call is refused uniformly", async () => {
    const res = await post(toolCall("lookup_customer_history", { phone: VICTIM }, { customer: { number: ALICE } }))
    const body = (await res.json()) as { results: { toolCallId: string; result: string }[] }
    expect(body.results).toEqual([{ toolCallId: "tc-1", result: CALLER_IDENTITY_REFUSAL }])
  })

  it("tool-calls: the caller's own call works and returns only their file", async () => {
    const res = await post(toolCall("lookup_customer_history", {}, { customer: { number: ALICE } }))
    const { results } = (await res.json()) as { results: { result: string }[] }
    expect(results[0].result).toContain("Alice Park")
    for (const leak of LEAKS) expect(results[0].result).not.toContain(leak)
  })

  it("a call with only call.phoneNumber (the shop's own line) has NO caller identity", async () => {
    // A customer exists on the shop's line in the fixture; the old fallback
    // would have treated the shop's number as "the caller" and read/staged
    // against that customer.
    for (const name of ["lookup_customer_history", "cancel_appointment"]) {
      const res = await post(toolCall(name, {}, { phoneNumber: { number: SHOP_LINE } }))
      const { results } = (await res.json()) as { results: { result: string }[] }
      expect(results[0].result, name).toBe(CALLER_IDENTITY_REFUSAL)
    }
    expect(db.inserts).toHaveLength(0)
  })

  it("blocked caller ID (customer.number = 'anonymous') fails closed", async () => {
    const res = await post(toolCall("capture_lead", { customer_name: "Pat" }, { customer: { number: "anonymous" } }))
    const { results } = (await res.json()) as { results: { result: string }[] }
    expect(results[0].result).toBe(CALLER_IDENTITY_REFUSAL)
    expect(db.inserts).toHaveLength(0)
  })

  it("legacy function-call event is bound the same way", async () => {
    const res = await post({
      type: "function-call",
      call: { id: "call-fc", assistantId: "asst-a", customer: { number: ALICE } },
      functionCall: { name: "cancel_appointment", parameters: { phone: VICTIM } },
    })
    expect(((await res.json()) as { result: string }).result).toBe(CALLER_IDENTITY_REFUSAL)
    expect(db.inserts).toHaveLength(0)
  })

  it("tenant scoping: the shop comes from the assistant, so a shop-B number is a stranger to shop A", async () => {
    const res = await post(toolCall("cancel_appointment", {}, { customer: { number: OUTSIDER } }))
    const { results } = (await res.json()) as { results: { result: string }[] }
    expect(results[0].result).not.toContain("Outsider")
    const staged = db.staged()
    expect(staged).toHaveLength(1)
    expect(staged[0].shop_id).toBe(SHOP_A)
    expect((staged[0].payload as Row).appointment_id).toBeNull()
  })

  it("a wrong secret is still rejected before any tool runs", async () => {
    const res = await post(toolCall("cancel_appointment", {}, { customer: { number: ALICE } }), "wrong")
    expect(res.status).toBe(401)
    expect(db.inserts).toHaveLength(0)
  })
})
