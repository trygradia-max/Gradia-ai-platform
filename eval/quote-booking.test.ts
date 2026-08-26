import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import * as aurinko from "@/lib/aurinko"
import * as availability from "@/lib/availability"
import * as pipeline from "@/lib/pipeline"
import { executeApproval } from "@/lib/approvals"

/**
 * P0-009 — quote-backed booking execution, Tier 1. Locks the executor-level
 * invariants with a mocked client: a payload carrying quote/lead refs
 * resolves the quote's EXISTING lead (no duplicate pipeline card), refs are
 * re-validated shop-scoped (forged/foreign ids fall back to create, never
 * resolve), the quote advances to `booked` only AFTER the durable
 * appointment write, refusal/failure never advances it, and replay repeats
 * the bookkeeping idempotently. Real-Postgres proofs live in
 * eval/integration/quote-acceptance.int.test.ts.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/pipeline", () => ({
  moveLeadToStage: vi.fn(async () => true),
  stageFromLegacyStatus: vi.fn(),
}))
vi.mock("@/lib/customers", () => ({
  findOrCreateCustomer: vi.fn(async () => ({
    ok: true,
    customer: { id: "cust-1" },
  })),
  findCustomerByChannel: vi.fn(async () => null),
}))
vi.mock("@/lib/vehicles", () => ({
  upsertCustomerVehicle: vi.fn(async () => null),
  vehiclesByCustomerIds: vi.fn(async () => new Map()),
}))
vi.mock("@/lib/crm-provider", () => ({
  pushBookingToCrm: vi.fn(async () => undefined),
  pushLeadToCrm: vi.fn(async () => undefined),
}))
vi.mock("@/lib/agent-events", () => ({
  dispatchAgentEvent: vi.fn(async () => undefined),
}))
vi.mock("@/lib/memory", () => ({
  recordInteraction: vi.fn(async () => ({ ok: true, id: "int-1", embedded: false })),
}))
vi.mock("@/lib/aurinko", async (importOriginal) => {
  const original = await importOriginal<typeof aurinko>()
  return {
    ...original,
    getAccessTokenForShop: vi.fn(async () => "token-1"),
    listCalendarEvents: vi.fn(async () => []),
    createCalendarEvent: vi.fn(async () => ({
      id: "ev-1",
      subject: "x",
      start: null,
      end: null,
      location: null,
    })),
    updateCalendarEventTime: vi.fn(async () => undefined),
    deleteCalendarEvent: vi.fn(async () => undefined),
  }
})
vi.mock("@/lib/availability", async (importOriginal) => {
  const original = await importOriginal<typeof availability>()
  return {
    ...original,
    checkAvailability: vi.fn(async () => ({
      available: true,
      conflicts: [],
      calendar: "unchecked" as const,
      calendarUncheckedReason: "not_connected" as const,
      range: { start: RANGE.start, end: RANGE.end },
      excludedAppointmentId: null,
      override: null,
    })),
  }
})

const mockedMoveLeadToStage = vi.mocked(pipeline.moveLeadToStage)

const RANGE = {
  start: "2030-02-01T17:00:00.000Z",
  end: "2030-02-01T19:00:00.000Z",
}

type Write = { table: string; op: "insert" | "update"; values: Record<string, unknown> }

function quotePayload(extras: Record<string, unknown> = {}) {
  return {
    customer_name: "Ada Lovelace",
    phone: "+15035550100",
    car_info: null,
    service: "Full Detail",
    iso_start_time: RANGE.start,
    duration_minutes: 120,
    timezone: null,
    email: null,
    pin_notes: "Booked from quote — total 250",
    source: "quote_page",
    quote_id: "q-1",
    lead_id: "lead-1",
    ...extras,
  }
}

/**
 * Chainable mock in the booking-atomicity.test.ts pattern, extended with a
 * per-table terminal-row config so the quote/lead resolution reads can be
 * steered per test.
 */
function mockDb(opts: {
  payload?: Record<string, unknown>
  rpcResult?: Record<string, unknown> | Error
  /** maybeSingle/single terminal rows per table (quotes, leads, appointments…). */
  tables?: Record<string, Record<string, unknown> | null>
  /** Per-table read ERROR (a real fault, distinct from a clean not-found). */
  readErrors?: Record<string, { message: string }>
  writes?: Write[]
}): SupabaseClient {
  const writes = opts.writes ?? []
  const claimed = {
    id: "pa-1",
    shop_id: "shop-1",
    action_type: "book_appointment",
    payload: opts.payload ?? quotePayload(),
  }
  return {
    rpc: () => {
      if (opts.rpcResult instanceof Error) {
        return Promise.resolve({ data: null, error: { message: opts.rpcResult.message } })
      }
      return Promise.resolve({
        data: opts.rpcResult ?? { status: "inserted", id: "appt-new" },
        error: null,
      })
    },
    from: (table: string) => {
      const terminal =
        table === "pending_actions"
          ? claimed
          : table === "shops"
            ? {
                id: "shop-1",
                location: null,
                twilio_phone_number: null, // skips the confirmation-SMS leg
                aurinko_account_id: null,
                aurinko_access_token_enc: "enc",
                aurinko_token_expires_at: null,
              }
            : (opts.tables?.[table] ?? null)
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "in", "gte", "lt", "order", "limit", "or"]) {
        chain[m] = () => chain
      }
      const readErr = opts.readErrors?.[table] ?? null
      chain.maybeSingle = () =>
        Promise.resolve(readErr ? { data: null, error: readErr } : { data: terminal, error: null })
      chain.single = () =>
        Promise.resolve(readErr ? { data: null, error: readErr } : { data: terminal, error: null })
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ data: null, error: null }))
      return {
        ...chain,
        update: (values: Record<string, unknown>) => {
          writes.push({ table, op: "update", values })
          return chain
        },
        insert: (values: Record<string, unknown>) => {
          writes.push({ table, op: "insert", values })
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: `${table}-new` }, error: null }),
            }),
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

const RESOLVING_TABLES = {
  quotes: { id: "q-1", lead_id: "lead-1" },
  leads: { id: "lead-1" },
}

function leadInserts(writes: Write[]): Write[] {
  return writes.filter((w) => w.table === "leads" && w.op === "insert")
}
function quoteStatusUpdates(writes: Write[]): Write[] {
  return writes.filter(
    (w) => w.table === "quotes" && w.op === "update" && w.values.status === "booked"
  )
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT", "true")
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe("executeBookAppointment — quote refs resolve the EXISTING lead (P0-009)", () => {
  it("payload with quote_id/lead_id: NO new lead; existing lead moves to booked; appointment linked", async () => {
    const writes: Write[] = []
    const db = mockDb({ tables: RESOLVING_TABLES, writes })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(leadInserts(writes)).toHaveLength(0)
    expect(mockedMoveLeadToStage).toHaveBeenCalledWith(db, "shop-1", "lead-1", "booked", {
      by: "system",
    })
    const link = writes.find(
      (w) => w.table === "appointments" && w.values.lead_id === "lead-1"
    )
    expect(link).toBeDefined()
  })

  it("quote row is the trusted anchor: its lead link WINS over a mismatched payload lead_id", async () => {
    const writes: Write[] = []
    const db = mockDb({
      payload: quotePayload({ lead_id: "lead-forged" }),
      tables: { quotes: { id: "q-1", lead_id: "lead-real" }, leads: { id: "lead-real" } },
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(leadInserts(writes)).toHaveLength(0)
    expect(mockedMoveLeadToStage).toHaveBeenCalledWith(db, "shop-1", "lead-real", "booked", {
      by: "system",
    })
  })

  it("foreign/unknown refs (shop-scoped lookups return nothing): falls back to create, quote NOT advanced", async () => {
    const writes: Write[] = []
    const db = mockDb({
      tables: { quotes: null, leads: null }, // .eq(shop_id) filtered them out
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    // Historical behavior: a fresh lead, in THIS shop — the foreign rows untouched.
    expect(leadInserts(writes)).toHaveLength(1)
    expect(leadInserts(writes)[0].values.shop_id).toBe("shop-1")
    expect(quoteStatusUpdates(writes)).toHaveLength(0)
    expect(mockedMoveLeadToStage).toHaveBeenCalledWith(db, "shop-1", "leads-new", "booked", {
      by: "system",
    })
  })

  it("lead READ ERROR (transient fault, not a clean not-found): FAILS CLOSED — no duplicate lead, reconciliation recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const writes: Write[] = []
    const db = mockDb({
      tables: RESOLVING_TABLES,
      readErrors: { leads: { message: "connection reset" } },
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    // Appointment persisted → booking succeeds; but the uncertain lead read
    // must NOT spawn a replacement lead (that resurrects the duplicate card).
    expect(res.ok).toBe(true)
    expect(leadInserts(writes)).toHaveLength(0)
    expect(quoteStatusUpdates(writes)).toHaveLength(0)
    const recon = writes.find(
      (w) =>
        w.table === "pending_actions" &&
        w.op === "update" &&
        (w.values.payload as { reconciliation?: { kind?: string } } | undefined)?.reconciliation
          ?.kind === "lead_resolve_error"
    )
    expect(recon).toBeDefined()
  })

  it("quote resolves but its lead was deleted: fallback create, quote STILL advances to booked", async () => {
    const writes: Write[] = []
    const db = mockDb({
      tables: { quotes: { id: "q-1", lead_id: "lead-gone" }, leads: null },
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(leadInserts(writes)).toHaveLength(1)
    expect(quoteStatusUpdates(writes)).toHaveLength(1)
  })

  it("no refs at all (voice booking / old in-flight payload): create path unchanged, no quote reads matter", async () => {
    const writes: Write[] = []
    const db = mockDb({
      payload: quotePayload({ quote_id: undefined, lead_id: undefined, source: undefined }),
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(leadInserts(writes)).toHaveLength(1)
    expect(quoteStatusUpdates(writes)).toHaveLength(0)
  })
})

describe("executeBookAppointment — quote advances to booked only on DURABLE success", () => {
  it("successful serialized write → quotes.status = booked (shop-scoped, guarded)", async () => {
    const writes: Write[] = []
    const db = mockDb({ tables: RESOLVING_TABLES, writes })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(quoteStatusUpdates(writes)).toHaveLength(1)
    // Best-effort job link rides along.
    const jobLink = writes.find(
      (w) => w.table === "appointments" && w.values.quote_id === "q-1"
    )
    expect(jobLink).toBeDefined()
  })

  it("serialized-write CONFLICT → refused; quote NOT advanced, lead untouched", async () => {
    const writes: Write[] = []
    const db = mockDb({
      tables: RESOLVING_TABLES,
      rpcResult: { status: "conflict", conflict_ids: ["appt-race"] },
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    expect(quoteStatusUpdates(writes)).toHaveLength(0)
    expect(leadInserts(writes)).toHaveLength(0)
    expect(mockedMoveLeadToStage).not.toHaveBeenCalled()
  })

  it("serialized-write ERROR → failure; quote NOT advanced", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const writes: Write[] = []
    const db = mockDb({
      tables: RESOLVING_TABLES,
      rpcResult: new Error("insert exploded"),
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    expect(quoteStatusUpdates(writes)).toHaveLength(0)
  })

  it("replay ('exists'): executed idempotently AND the quote/lead bookkeeping self-heals", async () => {
    const writes: Write[] = []
    const db = mockDb({
      tables: RESOLVING_TABLES,
      rpcResult: { status: "exists", id: "appt-original" },
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ status: "executed", resultId: "appt-original" })
    // No duplicate lead, but the (idempotent) stage move + quote advance re-run
    // so a crash between the appointment write and this bookkeeping repairs.
    expect(leadInserts(writes)).toHaveLength(0)
    expect(mockedMoveLeadToStage).toHaveBeenCalledWith(db, "shop-1", "lead-1", "booked", {
      by: "system",
    })
    expect(quoteStatusUpdates(writes)).toHaveLength(1)
  })

  it("replay fast-path (prior appointment row): same idempotent repair", async () => {
    const writes: Write[] = []
    const db = mockDb({
      tables: { ...RESOLVING_TABLES, appointments: { id: "appt-prior" } },
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ status: "executed", resultId: "appt-prior" })
    expect(leadInserts(writes)).toHaveLength(0)
    expect(mockedMoveLeadToStage).toHaveBeenCalledWith(db, "shop-1", "lead-1", "booked", {
      by: "system",
    })
    expect(quoteStatusUpdates(writes)).toHaveLength(1)
  })
})
