import { afterEach, describe, expect, it, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import * as memory from "@/lib/memory"
import * as pipeline from "@/lib/pipeline"
import * as rateLimit from "@/lib/rate-limit"
import { isQuoteExpired } from "@/lib/quotes"
import { respondToQuote } from "@/app/actions/quote-response"

/**
 * P0-009 — public quote response, Tier 1. Locks the server-side money-path
 * guards with a mocked client: expiry enforced at the mutation boundary
 * (never trusting the browser), atomic status transition (double-submit
 * stages at most ONE booking), payload carries the quote/lead refs, and the
 * no-phone acceptance is recorded — never a silent drop. Real-Postgres
 * proofs (true concurrency, one-lead-total, tenant tampering) live in
 * eval/integration/quote-acceptance.int.test.ts.
 */

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => currentDb),
}))
vi.mock("@/lib/memory", () => ({
  recordInteraction: vi.fn(async () => ({ ok: true, id: "int-1", embedded: false })),
}))
vi.mock("@/lib/pipeline", () => ({
  moveLeadToStage: vi.fn(async () => true),
}))
vi.mock("@/lib/availability", () => ({
  stagingAvailability: vi.fn(async () => ({ summary: null })),
}))
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof rateLimit>()
  return {
    ...original,
    checkRateLimit: vi.fn(async () => ({
      allowed: true,
      remaining: 9,
      resetInSeconds: 60,
    })),
  }
})

const mockedRecordInteraction = vi.mocked(memory.recordInteraction)
const mockedMoveLeadToStage = vi.mocked(pipeline.moveLeadToStage)
const mockedCheckRateLimit = vi.mocked(rateLimit.checkRateLimit)

const TOKEN = "tok-0123456789abcdef0123456789abcdef"

type Call = {
  table: string
  op: "select" | "update" | "insert"
  values?: Record<string, unknown>
  filters: Array<[string, unknown]>
}

function baseQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    shop_id: "shop-1",
    customer_id: "cust-1",
    lead_id: "lead-1",
    status: "viewed",
    valid_until: null,
    responded_at: null,
    total_cents: 25000,
    line_items: [{ service_id: null, name: "Full Detail", base_cents: 25000, price_cents: 25000 }],
    shops: { id: "shop-1", name: "Shine Co", owner_id: "owner-1", voice_config: null },
    customers: { id: "cust-1", name: "Ada Lovelace", phone: "+15035550100", email: "ada@example.test" },
    ...overrides,
  }
}

let currentDb: SupabaseClient

function mockDb(cfg: {
  quote?: Record<string, unknown> | null
  /** Rows the atomic quotes-update claim returns ([] = lost the race). */
  claimRows?: Array<{ id: string }>
  /** Status the race-echo re-read reports. */
  currentStatus?: string
  /** Existing staged booking cards for hasStagedQuoteBooking. */
  stagedBookings?: Array<{ id: string }>
  pendingInsertError?: { message: string } | null
  calls?: Call[]
}): SupabaseClient {
  const calls = cfg.calls ?? []
  const db = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] }
      calls.push(call)
      const exec = (): { data: unknown; error: { message: string } | null } => {
        if (table === "quotes" && call.op === "select") {
          if (call.filters.some(([k]) => k === "public_token")) {
            return { data: cfg.quote === undefined ? baseQuote() : cfg.quote, error: null }
          }
          return {
            data: cfg.currentStatus ? { status: cfg.currentStatus } : null,
            error: null,
          }
        }
        if (table === "quotes" && call.op === "update") {
          return { data: cfg.claimRows ?? [{ id: "q-1" }], error: null }
        }
        if (table === "pending_actions" && call.op === "select") {
          return { data: cfg.stagedBookings ?? [], error: null }
        }
        if (table === "pending_actions" && call.op === "insert") {
          return cfg.pendingInsertError
            ? { data: null, error: cfg.pendingInsertError }
            : { data: { id: "pa-1" }, error: null }
        }
        return { data: null, error: null }
      }
      const chain: Record<string, unknown> = {}
      for (const m of ["eq", "in", "or", "limit"]) {
        chain[m] = (k: unknown, v?: unknown) => {
          call.filters.push([String(k), v])
          return chain
        }
      }
      chain.select = () => chain
      chain.update = (values: Record<string, unknown>) => {
        call.op = "update"
        call.values = values
        return chain
      }
      chain.insert = (values: Record<string, unknown>) => {
        call.op = "insert"
        call.values = values
        return chain
      }
      chain.maybeSingle = () => Promise.resolve(exec())
      chain.single = () => Promise.resolve(exec())
      chain.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(exec()).then(resolve, reject)
      return chain
    },
  }
  return db as unknown as SupabaseClient
}

function mutations(calls: Call[]): Call[] {
  return calls.filter((c) => c.op !== "select")
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetInSeconds: 60 })
})

describe("isQuoteExpired — the one boundary rule (UTC end-of-day)", () => {
  it("null / undefined / unreadable never expire (non-expiring quotes stay open)", () => {
    expect(isQuoteExpired(null)).toBe(false)
    expect(isQuoteExpired(undefined)).toBe(false)
    expect(isQuoteExpired("not-a-date")).toBe(false)
  })

  it("valid through the WHOLE valid_until day, expired the instant after", () => {
    const validUntil = "2026-08-25"
    expect(isQuoteExpired(validUntil, new Date("2026-08-25T00:00:00.000Z"))).toBe(false)
    expect(isQuoteExpired(validUntil, new Date("2026-08-25T12:00:00.000Z"))).toBe(false)
    expect(isQuoteExpired(validUntil, new Date("2026-08-25T23:59:59.999Z"))).toBe(false)
    expect(isQuoteExpired(validUntil, new Date("2026-08-26T00:00:00.000Z"))).toBe(true)
    expect(isQuoteExpired(validUntil, new Date("2026-09-01T00:00:00.000Z"))).toBe(true)
  })

  it("day before is always valid", () => {
    expect(isQuoteExpired("2026-08-25", new Date("2026-08-24T23:59:00.000Z"))).toBe(false)
  })
})

describe("respondToQuote — expiry enforced server-side at the mutation boundary", () => {
  it("expired quote: accept refused, ZERO side effects (stale-tab submit covered)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const calls: Call[] = []
    currentDb = mockDb({ quote: baseQuote({ valid_until: "2020-01-01" }), calls })
    const res = await respondToQuote(TOKEN, "accept", "2030-02-01T17:00:00.000Z")
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("expired")
    expect(mutations(calls)).toHaveLength(0)
    expect(mockedRecordInteraction).not.toHaveBeenCalled()
    expect(mockedMoveLeadToStage).not.toHaveBeenCalled()
  })

  it("expired quote: decline refused too, zero side effects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const calls: Call[] = []
    currentDb = mockDb({ quote: baseQuote({ valid_until: "2020-01-01" }), calls })
    const res = await respondToQuote(TOKEN, "decline")
    expect(res.ok).toBe(false)
    expect(mutations(calls)).toHaveLength(0)
  })

  it("valid_until today (day-of) still accepts", async () => {
    const today = new Date().toISOString().slice(0, 10)
    currentDb = mockDb({ quote: baseQuote({ valid_until: today }) })
    const res = await respondToQuote(TOKEN, "accept", null)
    expect(res.ok).toBe(true)
  })

  it("null valid_until never locks out", async () => {
    currentDb = mockDb({ quote: baseQuote({ valid_until: null }) })
    const res = await respondToQuote(TOKEN, "accept", null)
    expect(res.ok).toBe(true)
  })
})

describe("respondToQuote — token + rate-limit guards on the public surface", () => {
  it("short token refused (loadPublicQuote parity), no DB touched", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ calls })
    const res = await respondToQuote("short", "accept")
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("unknown token → invalid, zero state changes", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ quote: null, calls })
    const res = await respondToQuote(TOKEN, "accept")
    expect(res.ok).toBe(false)
    expect(mutations(calls)).toHaveLength(0)
  })

  it("rate limited → typed refusal before any mutation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetInSeconds: 30 })
    const calls: Call[] = []
    currentDb = mockDb({ calls })
    const res = await respondToQuote(TOKEN, "accept")
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toMatch(/many tries/i)
    expect(mutations(calls)).toHaveLength(0)
  })
})

describe("respondToQuote — acceptance stages the quote-linked booking", () => {
  it("accept with a time: payload carries quote_id AND lead_id for the executor", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ calls })
    const res = await respondToQuote(TOKEN, "accept", "2030-02-01T17:00:00.000Z")
    expect(res).toEqual({ ok: true, status: "accepted", bookingStaged: true })
    const staged = calls.find((c) => c.table === "pending_actions" && c.op === "insert")
    expect(staged).toBeDefined()
    const payload = (staged?.values as { payload: Record<string, unknown> }).payload
    expect(payload.quote_id).toBe("q-1")
    expect(payload.lead_id).toBe("lead-1")
    expect(payload.source).toBe("quote_page")
  })

  it("atomic claim: the status update is guarded to sent/viewed (exactly-once transition)", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ calls })
    await respondToQuote(TOKEN, "accept", null)
    const claim = calls.find((c) => c.table === "quotes" && c.op === "update")
    expect(claim).toBeDefined()
    expect(claim?.values?.status).toBe("accepted")
    expect(claim?.filters).toContainEqual(["status", ["sent", "viewed"]])
    expect(claim?.filters).toContainEqual(["shop_id", "shop-1"])
  })

  it("replayed accept (already accepted): idempotent echo, NOTHING re-staged", async () => {
    const calls: Call[] = []
    currentDb = mockDb({
      quote: baseQuote({ status: "accepted" }),
      stagedBookings: [{ id: "pa-existing" }],
      calls,
    })
    const res = await respondToQuote(TOKEN, "accept", "2030-02-01T17:00:00.000Z")
    expect(res).toEqual({ ok: true, status: "accepted", bookingStaged: true })
    expect(mutations(calls)).toHaveLength(0)
    expect(mockedRecordInteraction).not.toHaveBeenCalled()
  })

  it("race loser (zero rows claimed): echoes what actually landed, stages nothing", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ claimRows: [], currentStatus: "accepted", calls })
    const res = await respondToQuote(TOKEN, "accept", "2030-02-01T17:00:00.000Z")
    expect(res.ok).toBe(true)
    expect(calls.filter((c) => c.table === "pending_actions" && c.op === "insert")).toHaveLength(0)
  })

  it("race loser to the OPPOSITE response → honest refusal", async () => {
    currentDb = mockDb({ claimRows: [], currentStatus: "declined" })
    const res = await respondToQuote(TOKEN, "accept")
    expect(res.ok).toBe(false)
  })

  it("already declined: accept refused, no mutation", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ quote: baseQuote({ status: "declined" }), calls })
    const res = await respondToQuote(TOKEN, "accept")
    expect(res.ok).toBe(false)
    expect(mutations(calls)).toHaveLength(0)
  })

  it("draft quote (never sent) can't be responded to", async () => {
    currentDb = mockDb({ quote: baseQuote({ status: "draft" }) })
    const res = await respondToQuote(TOKEN, "accept")
    expect(res.ok).toBe(false)
  })
})

describe("respondToQuote — no-phone / staging-failure acceptance is never silent", () => {
  it("no phone + picked time: accepted, bookingStaged false, timeline note recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const calls: Call[] = []
    currentDb = mockDb({
      quote: baseQuote({
        customers: { id: "cust-1", name: "Ada", phone: null, email: "ada@example.test" },
      }),
      calls,
    })
    const res = await respondToQuote(TOKEN, "accept", "2030-02-01T17:00:00.000Z")
    expect(res).toEqual({ ok: true, status: "accepted", bookingStaged: false })
    expect(calls.filter((c) => c.table === "pending_actions" && c.op === "insert")).toHaveLength(0)
    const note = mockedRecordInteraction.mock.calls.find(
      ([, input]) =>
        (input.metadata as { event?: string } | undefined)?.event === "accepted_no_booking"
    )
    expect(note).toBeDefined()
    expect((note?.[1].metadata as { reason?: string }).reason).toBe("no_phone")
    expect(note?.[1].content).toContain("no phone")
  })

  it("staging insert failure: accepted, bookingStaged false, note records the drop", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    currentDb = mockDb({ pendingInsertError: { message: "insert exploded" } })
    const res = await respondToQuote(TOKEN, "accept", "2030-02-01T17:00:00.000Z")
    expect(res).toEqual({ ok: true, status: "accepted", bookingStaged: false })
    const note = mockedRecordInteraction.mock.calls.find(
      ([, input]) =>
        (input.metadata as { event?: string } | undefined)?.event === "accepted_no_booking"
    )
    expect((note?.[1].metadata as { reason?: string }).reason).toBe("staging_failed")
  })

  it("accept WITHOUT a time: fine, nothing staged, no drop note (nothing was dropped)", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ calls })
    const res = await respondToQuote(TOKEN, "accept", null)
    expect(res).toEqual({ ok: true, status: "accepted", bookingStaged: false })
    const note = mockedRecordInteraction.mock.calls.find(
      ([, input]) =>
        (input.metadata as { event?: string } | undefined)?.event === "accepted_no_booking"
    )
    expect(note).toBeUndefined()
  })
})

describe("respondToQuote — decline path unchanged and replay-safe", () => {
  it("decline: quote → declined, existing lead → lost, nothing staged", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ calls })
    const res = await respondToQuote(TOKEN, "decline")
    expect(res).toEqual({ ok: true, status: "declined", bookingStaged: false })
    expect(mockedMoveLeadToStage).toHaveBeenCalledWith(currentDb, "shop-1", "lead-1", "lost", {
      by: "system",
      lostReason: "other",
    })
    expect(calls.filter((c) => c.table === "pending_actions" && c.op === "insert")).toHaveLength(0)
  })

  it("replayed decline: idempotent echo, no second lost-move", async () => {
    const calls: Call[] = []
    currentDb = mockDb({ quote: baseQuote({ status: "declined" }), calls })
    const res = await respondToQuote(TOKEN, "decline")
    expect(res).toEqual({ ok: true, status: "declined", bookingStaged: false })
    expect(mutations(calls)).toHaveLength(0)
    expect(mockedMoveLeadToStage).not.toHaveBeenCalled()
  })
})
