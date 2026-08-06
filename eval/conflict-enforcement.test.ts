import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import * as availability from "@/lib/availability"
import type {
  AvailabilityConflict,
  AvailabilityResult,
} from "@/lib/availability"
import { executeApproval } from "@/lib/approvals"
import { ALWAYS_HITL, isAutonomyAllowed } from "@/lib/autonomy"
import { FEATURES } from "@/lib/features"
import { proposeBooking } from "@/lib/vapi-tools"

/**
 * P0-004 — conflict enforcement wiring (D-015/D-016). The ALGORITHM is
 * covered by eval/availability.test.ts; these tests lock the POLICY at the
 * call sites: automatic paths hard-block (and ignore overrides), HITL paths
 * demand a valid authorized override, degraded checks behave per the locked
 * matrix, and no call site grows its own conflict logic.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

vi.mock("@/lib/availability", async (importOriginal) => {
  const original = await importOriginal<typeof availability>()
  return {
    ...original,
    checkAvailability: vi.fn(async () => cleanResult()),
    stagingAvailability: vi.fn(async () => ({ summary: null, blocking: [] })),
  }
})

const mockedCheck = vi.mocked(availability.checkAvailability)
const mockedStaging = vi.mocked(availability.stagingAvailability)

const RANGE = { start: "2030-01-01T17:00:00.000Z", end: "2030-01-01T19:00:00.000Z" }

function cleanResult(
  calendar: "checked" | "unchecked" = "unchecked"
): AvailabilityResult {
  return {
    available: true,
    conflicts: [],
    calendar,
    ...(calendar === "unchecked"
      ? { calendarUncheckedReason: "not_connected" as const }
      : {}),
    range: RANGE,
    excludedAppointmentId: null,
    override: null,
  }
}

function conflict(
  id: string,
  opts?: { blockTime?: boolean }
): AvailabilityConflict {
  return {
    source: "appointment",
    id,
    start: RANGE.start,
    end: RANGE.end,
    label: opts?.blockTime
      ? `Blocked time from ${RANGE.start} to ${RANGE.end}`
      : `Existing Full Detail from ${RANGE.start} to ${RANGE.end}`,
    blockTime: opts?.blockTime ?? false,
    resource: null,
    severity: "blocking",
    metadata: {},
  }
}

function conflictResult(...conflicts: AvailabilityConflict[]): AvailabilityResult {
  return { ...cleanResult(), available: false, conflicts }
}

// ---------------------------------------------------------------------------
// Recording Supabase mock for the approval engine
// ---------------------------------------------------------------------------

type Update = { table: string; values: Record<string, unknown> }

function mockDb(opts: {
  claimed: Record<string, unknown> | null
  shop?: Record<string, unknown> | null
  appointment?: Record<string, unknown> | null
  updates?: Update[]
}): SupabaseClient {
  const updates = opts.updates ?? []
  return {
    from: (table: string) => {
      const make = (terminal: unknown) => {
        const chain: Record<string, unknown> = {}
        for (const m of ["select", "eq", "in", "gte", "lt", "order", "limit", "or"]) {
          chain[m] = () => chain
        }
        chain.maybeSingle = () => Promise.resolve({ data: terminal, error: null })
        chain.single = () => Promise.resolve({ data: terminal, error: null })
        // Bare-awaited chains (rollback, payload writes, inserts).
        chain.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: null, error: null }))
        return chain
      }
      const terminal =
        table === "pending_actions"
          ? opts.claimed
          : table === "shops"
            ? (opts.shop ?? null)
            : table === "appointments"
              ? (opts.appointment ?? null)
              : null
      return {
        ...make(terminal),
        update: (values: Record<string, unknown>) => {
          updates.push({ table, values })
          return make(terminal)
        },
        insert: (values: Record<string, unknown>) => {
          updates.push({ table: `${table}.insert`, values })
          return make({ id: `${table}-new` })
        },
      }
    },
  } as unknown as SupabaseClient
}

const bookingPayload = {
  customer_name: "Sam",
  phone: "+15035550101",
  car_info: null,
  service: "Full Detail",
  iso_start_time: RANGE.start,
  duration_minutes: 120,
  timezone: null,
  email: null,
  pin_notes: null,
}

function claimedBooking(
  payloadExtras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "pa-1",
    shop_id: "shop-1",
    action_type: "book_appointment",
    payload: { ...bookingPayload, ...payloadExtras },
  }
}

const validOverride = {
  by: "owner-1",
  at: "2030-01-01T00:00:00.000Z",
  conflicts: ["appointment:appt-1"],
  reason: "Double-staffed on purpose",
}

function rollbackUpdates(updates: Update[]): Update[] {
  return updates.filter(
    (u) => u.table === "pending_actions" && u.values.status === "pending"
  )
}

function availabilityWrites(updates: Update[]): Update[] {
  return updates.filter(
    (u) =>
      u.table === "pending_actions" &&
      u.values.payload !== undefined &&
      (u.values.payload as { availability?: unknown }).availability !== undefined
  )
}

afterEach(() => {
  vi.clearAllMocks()
  mockedCheck.mockResolvedValue(cleanResult())
  mockedStaging.mockResolvedValue({ summary: null, blocking: [] })
})

// ---------------------------------------------------------------------------
// Execution-time gate — automatic context (D-015)
// ---------------------------------------------------------------------------

describe("executor, automatic context — hard block (D-015)", () => {
  it("appointment conflict → refused, rolled back to pending, conflicts written to the card", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("appt-1")))
    const updates: Update[] = []
    const db = mockDb({ claimed: claimedBooking(), updates })

    const res = await executeApproval(
      db,
      "pa-1",
      { userId: "owner-1" },
      { context: "automatic" }
    )

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("already taken")
    expect(res.availability?.conflicts.map((c) => c.key)).toContain(
      "appointment:appt-1"
    )
    expect(rollbackUpdates(updates)).toHaveLength(1)
    expect(availabilityWrites(updates)).toHaveLength(1)
    // Refusal happens BEFORE any external write: no lead/appointment insert.
    expect(updates.filter((u) => u.table.endsWith(".insert"))).toHaveLength(0)
  })

  it("blocked time conflicts exactly like a booking", async () => {
    mockedCheck.mockResolvedValue(
      conflictResult(conflict("block-1", { blockTime: true }))
    )
    const db = mockDb({ claimed: claimedBooking() })
    const res = await executeApproval(
      db,
      "pa-1",
      { userId: "owner-1" },
      { context: "automatic" }
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("Blocked time")
  })

  it("override metadata is IGNORED in automatic context — never silently overridden", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("appt-1")))
    const db = mockDb({
      claimed: claimedBooking({ conflict_override: validOverride }),
    })
    const res = await executeApproval(
      db,
      "pa-1",
      { userId: "owner-1" },
      { context: "automatic" }
    )
    expect(res.ok).toBe(false)
  })

  it("clean Gradia data with calendar unchecked → proceeds (calendar is advisory, D-013)", async () => {
    mockedCheck.mockResolvedValue(cleanResult("unchecked"))
    // shop: null → the next step (Aurinko requirement) fails, which proves
    // the gate ALLOWED execution to continue past the conflict check.
    const db = mockDb({ claimed: claimedBooking(), shop: null })
    const res = await executeApproval(
      db,
      "pa-1",
      { userId: "owner-1" },
      { context: "automatic" }
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("Google Calendar")
    expect(res.availability).toBeUndefined()
  })

  it("check FAILURE → refuses (no honest 'clear' without a completed Gradia check)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mockedCheck.mockRejectedValue(new Error("appointments query failed"))
    const db = mockDb({ claimed: claimedBooking() })
    const res = await executeApproval(
      db,
      "pa-1",
      { userId: "owner-1" },
      { context: "automatic" }
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("Couldn't verify")
    expect(res.availability?.error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Execution-time gate — HITL context (D-016)
// ---------------------------------------------------------------------------

describe("executor, hitl context — warn + documented override (D-016)", () => {
  it("conflict without an override → refused with the override affordance named", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("appt-1")))
    const updates: Update[] = []
    const db = mockDb({ claimed: claimedBooking(), updates })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("Book it anyway")
    expect(rollbackUpdates(updates)).toHaveLength(1)
  })

  it("override missing a reason → refused", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("appt-1")))
    const db = mockDb({
      claimed: claimedBooking({
        conflict_override: { ...validOverride, reason: "" },
      }),
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
  })

  it("override by someone other than the approver → refused (unauthorized)", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("appt-1")))
    const db = mockDb({
      claimed: claimedBooking({ conflict_override: validOverride }),
    })
    const res = await executeApproval(db, "pa-1", { userId: "different-user" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("approving owner")
  })

  it("a Slack-only decider (no userId) can never satisfy an override", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("appt-1")))
    const db = mockDb({
      claimed: claimedBooking({ conflict_override: validOverride }),
    })
    const res = await executeApproval(db, "pa-1", { slackUserId: "U123" })
    expect(res.ok).toBe(false)
  })

  it("stale override that misses a NEW conflict → refused, card refreshed (race case)", async () => {
    mockedCheck.mockResolvedValue(
      conflictResult(conflict("appt-1"), conflict("appt-NEW"))
    )
    const updates: Update[] = []
    const db = mockDb({
      claimed: claimedBooking({ conflict_override: validOverride }),
      updates,
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("schedule changed")
    expect(availabilityWrites(updates)).toHaveLength(1)
  })

  it("valid authorized override → the gate opens (execution proceeds to the next step)", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("appt-1")))
    const db = mockDb({
      claimed: claimedBooking({ conflict_override: validOverride }),
      shop: null, // proves we got PAST the gate: failure is the Aurinko step
    })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("Google Calendar")
  })

  it("check FAILURE → proceeds; a human decided, degradation is honest not blocking", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    mockedCheck.mockRejectedValue(new Error("boom"))
    const db = mockDb({ claimed: claimedBooking(), shop: null })
    const res = await executeApproval(db, "pa-1", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("Google Calendar")
  })
})

// ---------------------------------------------------------------------------
// Reschedule executor — self-exclusion + same gate
// ---------------------------------------------------------------------------

describe("reschedule executor", () => {
  const reschedulePayload = {
    appointment_id: "appt-self",
    current_scheduled_at: "2030-01-01T15:00:00.000Z",
    service: "Full Detail",
    customer_name: "Sam",
    phone: "+15035550101",
    new_when: "5pm",
    iso_new_start_time: RANGE.start,
  }
  const appointmentRow = {
    id: "appt-self",
    shop_id: "shop-1",
    customer_id: "cust-1",
    duration_minutes: 120,
    scheduled_at: "2030-01-01T15:00:00.000Z",
    ends_at: null,
    aurinko_event_id: null,
    aurinko_calendar_id: null,
    timezone: null,
  }

  it("re-checks with the moving appointment excluded (self-exclusion)", async () => {
    mockedCheck.mockResolvedValue(conflictResult(conflict("other")))
    const db = mockDb({
      claimed: {
        id: "pa-2",
        shop_id: "shop-1",
        action_type: "reschedule_appointment",
        payload: reschedulePayload,
      },
      appointment: appointmentRow,
    })
    const res = await executeApproval(db, "pa-2", { userId: "owner-1" })
    expect(res.ok).toBe(false)
    expect(mockedCheck).toHaveBeenCalledWith(
      expect.anything(),
      "shop-1",
      expect.objectContaining({ excludeAppointmentId: "appt-self" })
    )
  })

  it("clean re-check → the move lands WITH a fresh ends_at (gate 8)", async () => {
    mockedCheck.mockResolvedValue(cleanResult())
    const updates: Update[] = []
    const db = mockDb({
      claimed: {
        id: "pa-2",
        shop_id: "shop-1",
        action_type: "reschedule_appointment",
        payload: reschedulePayload,
      },
      appointment: appointmentRow,
      updates,
    })
    const res = await executeApproval(db, "pa-2", { userId: "owner-1" })
    expect(res.ok).toBe(true)
    const move = updates.find(
      (u) => u.table === "appointments" && u.values.scheduled_at !== undefined
    )
    expect(move?.values.scheduled_at).toBe(RANGE.start)
    expect(move?.values.ends_at).toBe(RANGE.end)
  })
})

// ---------------------------------------------------------------------------
// Feature flag — off restores prior behavior
// ---------------------------------------------------------------------------

describe("FEATURES.conflictEnforcement off → dormant", () => {
  it("no availability check runs; execution proceeds as before", async () => {
    const flags = FEATURES as { conflictEnforcement: boolean }
    const prior = flags.conflictEnforcement
    flags.conflictEnforcement = false
    try {
      const db = mockDb({ claimed: claimedBooking(), shop: null })
      const res = await executeApproval(
        db,
        "pa-1",
        { userId: "owner-1" },
        { context: "automatic" }
      )
      expect(mockedCheck).not.toHaveBeenCalled()
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error("unreachable")
      expect(res.error).toContain("Google Calendar") // pre-P0-004 failure mode
    } finally {
      flags.conflictEnforcement = prior
    }
  })
})

// ---------------------------------------------------------------------------
// Voice staging — D-015 at the source
// ---------------------------------------------------------------------------

describe("voice proposeBooking — refuses to stage a knowingly-conflicting slot", () => {
  function voiceDb(inserts: { table: string; row: Record<string, unknown> }[]) {
    return {
      from: (table: string) => {
        const chain: Record<string, unknown> = {}
        for (const m of ["select", "eq", "or", "gte", "order", "limit"]) {
          chain[m] = () => chain
        }
        chain.maybeSingle = () => Promise.resolve({ data: null, error: null })
        chain.single = () =>
          Promise.resolve({
            data: table === "shops" ? { owner_id: "owner-1" } : null,
            error: null,
          })
        chain.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null }))
        return {
          ...chain,
          insert: (row: Record<string, unknown>) => {
            inserts.push({ table, row })
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

  const params = {
    customer_name: "Sam Rivera",
    phone: "+16175550142",
    service: "Full Detail",
    when: "Friday at 10",
    iso_start_time: RANGE.start,
    duration_minutes: 120,
  }

  it("blocking conflict → the caller hears it's taken, NOTHING is staged", async () => {
    mockedStaging.mockResolvedValue({
      summary: null,
      blocking: [conflict("appt-1")],
    })
    const inserts: { table: string; row: Record<string, unknown> }[] = []
    const spoken = await proposeBooking(voiceDb(inserts), "shop-1", params, {
      id: "call-1",
    })
    expect(spoken).toContain("already taken")
    expect(spoken).toContain("another")
    expect(inserts.filter((i) => i.table === "pending_actions")).toHaveLength(0)
  })

  it("clear slot → stages with the availability snapshot attached to the card payload", async () => {
    const summary = availability.summarizeAvailability(
      cleanResult(),
      "2030-01-01T00:00:00.000Z"
    )
    mockedStaging.mockResolvedValue({ summary, blocking: [] })
    const inserts: { table: string; row: Record<string, unknown> }[] = []
    const spoken = await proposeBooking(voiceDb(inserts), "shop-1", params, {
      id: "call-1",
    })
    const staged = inserts.filter((i) => i.table === "pending_actions")
    expect(staged).toHaveLength(1)
    expect(
      (staged[0].row.payload as Record<string, unknown>).availability
    ).toEqual(summary)
    expect(spoken).toContain("lock in")
  })
})

// ---------------------------------------------------------------------------
// Locked invariants — extended, never weakened
// ---------------------------------------------------------------------------

describe("ALWAYS_HITL floor — unchanged and now backed by the executor gate", () => {
  it("calendar + money actions all remain human-approved in every mode", () => {
    for (const action of [
      "book_appointment",
      "reschedule_appointment",
      "cancel_appointment",
      "create_quote",
    ] as const) {
      expect(ALWAYS_HITL.has(action)).toBe(true)
      expect(isAutonomyAllowed(action)).toBe(false)
    }
  })
})

describe("one conflict algorithm — no call site re-implements overlap math", () => {
  const SRC = join(process.cwd(), "src")

  function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) out.push(...tsFiles(p))
      else if (/\.(ts|tsx)$/.test(name)) out.push(p)
    }
    return out
  }

  it("rangesOverlap is defined only in src/lib/availability.ts", () => {
    const defining = tsFiles(SRC).filter((f) =>
      /function rangesOverlap|const rangesOverlap\s*=/.test(readFileSync(f, "utf8"))
    )
    expect(defining).toEqual([join(SRC, "lib", "availability.ts")])
  })

  it("every wired call site goes through the central service", () => {
    const wired = [
      "src/lib/approvals.ts",
      "src/lib/vapi-tools.ts",
      "src/app/actions/quote-response.ts",
      "src/app/actions/jobs.ts",
      "src/lib/owner-agent.ts",
      "src/lib/mcp/server.ts",
    ]
    for (const rel of wired) {
      const content = readFileSync(join(process.cwd(), rel), "utf8")
      expect(content, `${rel} must import the central availability service`).toMatch(
        /from "@\/lib\/availability"/
      )
    }
  })
})
