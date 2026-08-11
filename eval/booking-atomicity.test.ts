import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import * as aurinko from "@/lib/aurinko"
import { coveredAppointmentIds, writeAppointmentSerialized } from "@/lib/appointment-write"
import * as availability from "@/lib/availability"
import { executeApproval } from "@/lib/approvals"

/**
 * P0-004A (issue #13) — booking atomicity, Tier 1. Locks the executor-level
 * invariants with a mocked client: never "executed" without a persisted row,
 * refusal/rollback on the serialized write's conflict answer, idempotent
 * replay, Gradia-first ordering (no external event before the durable row),
 * and honest reconciliation state when calendar sync fails AFTER
 * persistence. The real-Postgres proofs (advisory-lock serialization, true
 * concurrency, replay against real rows) live in
 * eval/integration/booking-atomicity.int.test.ts.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/pipeline", () => ({
  moveLeadToStage: vi.fn(async () => undefined),
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

const mockedCreateEvent = vi.mocked(aurinko.createCalendarEvent)

const RANGE = {
  start: "2030-02-01T17:00:00.000Z",
  end: "2030-02-01T19:00:00.000Z",
}

type RpcCall = { fn: string; args: Record<string, unknown> }
type Write = { table: string; op: "insert" | "update"; values: Record<string, unknown> }

function mockDb(opts: {
  claimed?: Record<string, unknown> | null
  rpcResult?: Record<string, unknown> | Error
  rpcCalls?: RpcCall[]
  writes?: Write[]
}): SupabaseClient {
  const rpcCalls = opts.rpcCalls ?? []
  const writes = opts.writes ?? []
  const claimed =
    opts.claimed === undefined
      ? {
          id: "pa-1",
          shop_id: "shop-1",
          action_type: "book_appointment",
          payload: {
            customer_name: "Sam",
            phone: "+15035550101",
            car_info: null,
            service: "Full Detail",
            iso_start_time: RANGE.start,
            duration_minutes: 120,
            timezone: null,
            email: null,
            pin_notes: null,
          },
        }
      : opts.claimed
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (opts.rpcResult instanceof Error) {
        return Promise.resolve({
          data: null,
          error: { message: opts.rpcResult.message },
        })
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
            : null
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "in", "gte", "lt", "order", "limit", "or"]) {
        chain[m] = () => chain
      }
      chain.maybeSingle = () => Promise.resolve({ data: terminal, error: null })
      chain.single = () => Promise.resolve({ data: terminal, error: null })
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

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT", "true")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  mockedCreateEvent.mockResolvedValue({
    id: "ev-1",
    subject: "x",
    start: null,
    end: null,
    location: null,
  })
})

describe("coveredAppointmentIds — override keys → uuid[] for the serialized write", () => {
  const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"
  it("keeps appointment:<uuid> keys only", () => {
    expect(
      coveredAppointmentIds([
        `appointment:${U1}`,
        "calendar:ev-99",
        "outside_hours:2030-02-01",
        "appointment:not-a-uuid",
        "garbage",
      ])
    ).toEqual([U1])
  })
})

describe("writeAppointmentSerialized — response contract", () => {
  it("maps inserted/updated/exists/conflict/not_found; throws on RPC error", async () => {
    const ok = await writeAppointmentSerialized(
      mockDb({ rpcResult: { status: "inserted", id: "a-1" } }),
      "shop-1",
      { mode: "insert", start: new Date(RANGE.start), end: new Date(RANGE.end) }
    )
    expect(ok).toEqual({ status: "inserted", id: "a-1" })

    const conflict = await writeAppointmentSerialized(
      mockDb({ rpcResult: { status: "conflict", conflict_ids: ["x-1"] } }),
      "shop-1",
      { mode: "insert", start: new Date(RANGE.start), end: new Date(RANGE.end) }
    )
    expect(conflict).toEqual({ status: "conflict", conflictIds: ["x-1"] })

    await expect(
      writeAppointmentSerialized(mockDb({ rpcResult: new Error("boom") }), "shop-1", {
        mode: "move",
        appointmentId: "a-1",
        start: new Date(RANGE.start),
        end: new Date(RANGE.end),
      })
    ).rejects.toThrow(/serialized write failed/)
  })
})

describe("executeBookAppointment — atomicity invariants (P0-004A)", () => {
  it("serialized-write CONFLICT → refused, rolled back, no lead, no override audit, no calendar event", async () => {
    const rpcCalls: RpcCall[] = []
    const writes: Write[] = []
    const db = mockDb({
      rpcResult: { status: "conflict", conflict_ids: ["appt-race"] },
      rpcCalls,
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("taken while this card waited")
    expect(res.availability).toBeDefined()
    // Rolled back to pending — retryable.
    expect(
      writes.some(
        (w) => w.table === "pending_actions" && w.values.status === "pending"
      )
    ).toBe(true)
    // Nothing persisted, nothing audited, nothing synced.
    expect(writes.filter((w) => w.table === "leads" && w.op === "insert")).toHaveLength(0)
    expect(
      writes.filter((w) => w.table === "action_decisions" && w.op === "insert")
    ).toHaveLength(0)
    expect(mockedCreateEvent).not.toHaveBeenCalled()
  })

  it("serialized-write ERROR → failure result, never 'executed'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const db = mockDb({ rpcResult: new Error("insert exploded") })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("nothing was booked")
    expect(mockedCreateEvent).not.toHaveBeenCalled()
  })

  it("replay ('exists') → executed idempotently with the original row; no second side effects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const writes: Write[] = []
    const db = mockDb({
      rpcResult: { status: "exists", id: "appt-original" },
      writes,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ status: "executed", resultId: "appt-original" })
    expect(writes.filter((w) => w.table === "leads" && w.op === "insert")).toHaveLength(0)
    expect(mockedCreateEvent).not.toHaveBeenCalled()
  })

  it("Gradia-first ordering: the serialized write happens BEFORE any calendar event create", async () => {
    const order: string[] = []
    const rpcCalls: RpcCall[] = []
    mockedCreateEvent.mockImplementation(async () => {
      order.push("calendar")
      return { id: "ev-1", subject: "x", start: null, end: null, location: null }
    })
    const db = mockDb({ rpcCalls })
    const origRpc = db.rpc.bind(db)
    ;(db as { rpc: typeof db.rpc }).rpc = ((fn: string, args: never) => {
      order.push("rpc")
      return origRpc(fn, args)
    }) as typeof db.rpc
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(order.indexOf("rpc")).toBeLessThan(order.indexOf("calendar"))
  })

  it("calendar create fails AFTER persistence → still executed; sync failure recorded as reconciliation state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockedCreateEvent.mockRejectedValue(new Error("Aurinko 500"))
    const writes: Write[] = []
    const db = mockDb({ writes })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ status: "executed", calendarEventId: null })
    // Explicit reconciliation evidence on the action payload.
    const reconciliation = writes.find(
      (w) =>
        w.table === "pending_actions" &&
        w.values.payload !== undefined &&
        (w.values.payload as { calendar_sync?: { status?: string } }).calendar_sync
          ?.status === "failed"
    )
    expect(reconciliation).toBeDefined()
    // No rollback: the booking stands.
    expect(
      writes.some(
        (w) => w.table === "pending_actions" && w.values.status === "pending"
      )
    ).toBe(false)
  })

  it("success → executed, event linked onto the appointment row after creation", async () => {
    const writes: Write[] = []
    const db = mockDb({ writes })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ status: "executed", calendarEventId: "ev-1" })
    const link = writes.find(
      (w) => w.table === "appointments" && w.values.aurinko_event_id === "ev-1"
    )
    expect(link).toBeDefined()
  })
})
