import { afterEach, describe, expect, it, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  appointmentBusyRange,
  appointmentConflicts,
  calendarConflicts,
  checkAvailability,
  conflictKey,
  hoursAndCapacityConflicts,
  isBusyStatus,
  rangesOverlap,
  resolveConflictPolicy,
  toLocalWallTime,
  type AvailabilityConflict,
  type ConflictOverride,
} from "@/lib/availability"
import { DEFAULT_WORKING_HOURS, type WorkingHours } from "@/lib/working-hours"

import * as aurinko from "@/lib/aurinko"

/**
 * P0-003 — central appointment conflict service. Tier 1: pure overlap math,
 * status/block-time semantics, timezone edges, policy mapping (D-015/D-016),
 * and checkAvailability against a mocked Supabase client (tenant scoping,
 * reschedule exclusion, calendar degradation → `unchecked`, override
 * metadata never disabling detection). The DB tier lives in
 * eval/integration/availability.int.test.ts.
 */

vi.mock("@/lib/aurinko", async (importOriginal) => {
  const original = await importOriginal<typeof aurinko>()
  return {
    ...original,
    getAccessTokenForShop: vi.fn(async () => null),
    listCalendarEvents: vi.fn(async () => []),
  }
})

const mockedGetToken = vi.mocked(aurinko.getAccessTokenForShop)
const mockedListEvents = vi.mocked(aurinko.listCalendarEvents)

afterEach(() => {
  vi.restoreAllMocks()
  mockedGetToken.mockReset()
  mockedGetToken.mockResolvedValue(null)
  mockedListEvents.mockReset()
  mockedListEvents.mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// Pure overlap math
// ---------------------------------------------------------------------------

const T = (iso: string): number => Date.parse(iso)

describe("rangesOverlap — half-open [start, end)", () => {
  const start = T("2026-08-10T10:00:00Z")
  const end = T("2026-08-10T12:00:00Z")

  it("identical ranges conflict", () => {
    expect(rangesOverlap(start, end, start, end)).toBe(true)
  })

  it("partial overlap at the beginning conflicts", () => {
    expect(
      rangesOverlap(T("2026-08-10T09:00:00Z"), T("2026-08-10T11:00:00Z"), start, end)
    ).toBe(true)
  })

  it("partial overlap at the end conflicts", () => {
    expect(
      rangesOverlap(T("2026-08-10T11:00:00Z"), T("2026-08-10T13:00:00Z"), start, end)
    ).toBe(true)
  })

  it("containment conflicts both directions", () => {
    // existing contains proposed
    expect(
      rangesOverlap(T("2026-08-10T09:00:00Z"), T("2026-08-10T13:00:00Z"), start, end)
    ).toBe(true)
    // proposed contains existing
    expect(
      rangesOverlap(T("2026-08-10T10:30:00Z"), T("2026-08-10T11:30:00Z"), start, end)
    ).toBe(true)
  })

  it("adjacent before and after do NOT conflict (boundary touch)", () => {
    expect(
      rangesOverlap(T("2026-08-10T08:00:00Z"), T("2026-08-10T10:00:00Z"), start, end)
    ).toBe(false)
    expect(
      rangesOverlap(T("2026-08-10T12:00:00Z"), T("2026-08-10T14:00:00Z"), start, end)
    ).toBe(false)
  })

  it("fully disjoint ranges do not conflict", () => {
    expect(
      rangesOverlap(T("2026-08-11T10:00:00Z"), T("2026-08-11T12:00:00Z"), start, end)
    ).toBe(false)
  })
})

describe("appointmentBusyRange — stored-time conventions", () => {
  it("uses ends_at when valid", () => {
    const busy = appointmentBusyRange({
      scheduled_at: "2026-08-10T10:00:00Z",
      duration_minutes: 60,
      ends_at: "2026-08-12T10:00:00Z",
    })
    expect(busy).toEqual({
      startMs: T("2026-08-10T10:00:00Z"),
      endMs: T("2026-08-12T10:00:00Z"),
    })
  })

  it("falls back to duration_minutes, defaulting 90", () => {
    expect(
      appointmentBusyRange({
        scheduled_at: "2026-08-10T10:00:00Z",
        duration_minutes: 120,
        ends_at: null,
      })
    ).toEqual({
      startMs: T("2026-08-10T10:00:00Z"),
      endMs: T("2026-08-10T12:00:00Z"),
    })
    expect(
      appointmentBusyRange({
        scheduled_at: "2026-08-10T10:00:00Z",
        duration_minutes: null,
        ends_at: null,
      })?.endMs
    ).toBe(T("2026-08-10T11:30:00Z"))
  })

  it("ends_at before start falls back to duration; unparseable start → null (never throws)", () => {
    expect(
      appointmentBusyRange({
        scheduled_at: "2026-08-10T10:00:00Z",
        duration_minutes: 30,
        ends_at: "2026-08-10T09:00:00Z",
      })?.endMs
    ).toBe(T("2026-08-10T10:30:00Z"))
    expect(
      appointmentBusyRange({
        scheduled_at: "not-a-date",
        duration_minutes: 30,
        ends_at: null,
      })
    ).toBeNull()
  })
})

describe("isBusyStatus — cancelled rows are deleted; closed frees the slot", () => {
  it("closed is the only non-busy status", () => {
    expect(isBusyStatus("closed")).toBe(false)
    for (const s of [
      "booked",
      "confirmed",
      "checked_in",
      "in_progress",
      "on_hold",
      "completed",
      "paid",
    ]) {
      expect(isBusyStatus(s), `${s} should be busy`).toBe(true)
    }
  })

  it("null (pre-C1) is busy; unknown statuses are conservatively busy + logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(isBusyStatus(null)).toBe(true)
    expect(isBusyStatus("something_new")).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown appointment status")
    )
  })
})

// ---------------------------------------------------------------------------
// Appointment conflict assembly
// ---------------------------------------------------------------------------

type Candidate = Parameters<typeof appointmentConflicts>[0][number]

function candidate(overrides: Partial<Candidate> & { id: string }): Candidate {
  return {
    scheduled_at: "2026-08-10T10:00:00Z",
    duration_minutes: 120,
    ends_at: null,
    service_name: "Ceramic Coating",
    internal_note: null,
    status: "booked",
    access_notes: null,
    customer_id: "cust-1",
    aurinko_event_id: null,
    ...overrides,
  }
}

describe("appointmentConflicts", () => {
  const start = T("2026-08-10T11:00:00Z")
  const end = T("2026-08-10T13:00:00Z")

  it("reports an overlapping appointment with ids, range, and label", () => {
    const out = appointmentConflicts([candidate({ id: "appt-1" })], start, end)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "appointment",
      id: "appt-1",
      start: "2026-08-10T10:00:00.000Z",
      end: "2026-08-10T12:00:00.000Z",
      blockTime: false,
      severity: "blocking",
    })
    expect(out[0].label).toContain("Ceramic Coating")
  })

  it("includes [block-time] rows, flagged", () => {
    const out = appointmentConflicts(
      [
        candidate({
          id: "block-1",
          internal_note: "[block-time]",
          service_name: "Lunch",
        }),
      ],
      start,
      end
    )
    expect(out).toHaveLength(1)
    expect(out[0].blockTime).toBe(true)
    expect(out[0].label).toContain("Blocked time")
  })

  it("excludes closed rows; keeps unknown statuses (conservative)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = appointmentConflicts(
      [
        candidate({ id: "closed-1", status: "closed" }),
        candidate({ id: "weird-1", status: "mystery" as Candidate["status"] }),
      ],
      start,
      end
    )
    expect(out.map((c) => c.id)).toEqual(["weird-1"])
  })

  it("excludeAppointmentId removes only that row — others still conflict", () => {
    const rows = [candidate({ id: "self" }), candidate({ id: "other" })]
    const out = appointmentConflicts(rows, start, end, "self")
    expect(out.map((c) => c.id)).toEqual(["other"])
  })

  it("rows with unparseable times are skipped and logged, never a crash", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = appointmentConflicts(
      [candidate({ id: "bad-1", scheduled_at: "garbage" })],
      start,
      end
    )
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unparseable times")
    )
  })

  it("multi-day rows (ends_at spanning days) conflict on later days", () => {
    const out = appointmentConflicts(
      [
        candidate({
          id: "multi-1",
          scheduled_at: "2026-08-09T15:00:00Z",
          ends_at: "2026-08-11T15:00:00Z",
        }),
      ],
      start,
      end
    )
    expect(out.map((c) => c.id)).toEqual(["multi-1"])
  })

  it("surfaces the bay lane as the resource when recorded", () => {
    const out = appointmentConflicts(
      [candidate({ id: "appt-1", access_notes: { bay: "Bay 2" } })],
      start,
      end
    )
    expect(out[0].resource).toBe("Bay 2")
  })
})

describe("calendarConflicts — advisory external busy times", () => {
  const start = T("2026-08-10T11:00:00Z")
  const end = T("2026-08-10T13:00:00Z")

  it("reports overlapping events and skips Gradia-mirrored ones", () => {
    const events = [
      {
        id: "ev-1",
        subject: "Dentist",
        start: "2026-08-10T12:00:00Z",
        end: "2026-08-10T14:00:00Z",
        location: null,
      },
      {
        id: "ev-mirror",
        subject: "Detail — Sam",
        start: "2026-08-10T11:00:00Z",
        end: "2026-08-10T12:00:00Z",
        location: null,
      },
    ]
    const out = calendarConflicts(events, start, end, new Set(["ev-mirror"]))
    expect(out.map((c) => c.id)).toEqual(["ev-1"])
    expect(out[0].source).toBe("calendar")
  })

  it("skips events with unparseable or inverted times, logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = calendarConflicts(
      [
        { id: "ev-bad", subject: null, start: null, end: null, location: null },
        {
          id: "ev-inv",
          subject: null,
          start: "2026-08-10T12:00:00Z",
          end: "2026-08-10T11:00:00Z",
          location: null,
        },
      ],
      start,
      end,
      new Set()
    )
    expect(out).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Working hours / capacity + timezone edges
// ---------------------------------------------------------------------------

describe("hoursAndCapacityConflicts", () => {
  const NY = "America/New_York"

  it("inside working hours on a DST-transition day is clean (2026-03-08, EST→EDT)", () => {
    // 09:00–10:00 local on the US spring-forward day = 13:00–14:00 UTC (EDT).
    const out = hoursAndCapacityConflicts(
      T("2026-03-08T13:00:00Z"),
      T("2026-03-08T14:00:00Z"),
      NY,
      DEFAULT_WORKING_HOURS,
      []
    )
    expect(out).toEqual([])
  })

  it("the same UTC wall clock is outside hours before the DST shift", () => {
    // 13:00 UTC on 2026-03-07 (EST, UTC-5) = 08:00 local → before 09:00 open.
    const out = hoursAndCapacityConflicts(
      T("2026-03-07T13:00:00Z"),
      T("2026-03-07T14:00:00Z"),
      NY,
      DEFAULT_WORKING_HOURS,
      []
    )
    expect(out.map((c) => c.source)).toEqual(["outside_hours"])
    expect(out[0].severity).toBe("advisory")
  })

  it("a closed day reports outside_hours", () => {
    const hours: WorkingHours = { ...DEFAULT_WORKING_HOURS, sun: null }
    const out = hoursAndCapacityConflicts(
      T("2026-08-09T14:00:00Z"), // Sunday local
      T("2026-08-09T15:00:00Z"),
      NY,
      hours,
      []
    )
    expect(out.map((c) => c.source)).toEqual(["outside_hours"])
    expect(out[0].label).toContain("closed")
  })

  it("over-capacity reports when booked + proposed exceed workable minutes", () => {
    // Monday 09:00–17:00 = 480 workable minutes; 420 already booked
    // (13:00–20:00 UTC = 09:00–16:00 local), proposing 120 more.
    const out = hoursAndCapacityConflicts(
      T("2026-08-10T19:00:00Z"), // 15:00 local
      T("2026-08-10T21:00:00Z"), // 17:00 local
      NY,
      DEFAULT_WORKING_HOURS,
      [{ startMs: T("2026-08-10T13:00:00Z"), endMs: T("2026-08-10T20:00:00Z") }]
    )
    const capacity = out.find((c) => c.source === "over_capacity")
    expect(capacity).toBeDefined()
    expect(capacity?.metadata).toMatchObject({
      bookedMinutes: 420,
      proposedMinutes: 120,
      capacityMinutes: 480,
    })
  })

  it("invalid timezone falls back to UTC with a log, never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const local = toLocalWallTime(T("2026-08-10T10:00:00Z"), "Not/AZone")
    expect(local.minutesOfDay).toBe(10 * 60)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid shop timezone")
    )
  })
})

// ---------------------------------------------------------------------------
// Policy helper — D-015 / D-016
// ---------------------------------------------------------------------------

describe("resolveConflictPolicy", () => {
  it("automatic → hard_block (D-015); hitl → warn_allow_override (D-016)", () => {
    expect(resolveConflictPolicy("automatic")).toBe("hard_block")
    expect(resolveConflictPolicy("hitl")).toBe("warn_allow_override")
  })
})

describe("conflictKey", () => {
  it("is stable per source + id", () => {
    const conflict: AvailabilityConflict = {
      source: "appointment",
      id: "appt-1",
      start: null,
      end: null,
      label: "x",
      blockTime: false,
      resource: null,
      severity: "blocking",
    }
    expect(conflictKey(conflict)).toBe("appointment:appt-1")
  })
})

// ---------------------------------------------------------------------------
// checkAvailability against a mocked client
// ---------------------------------------------------------------------------

type Filter = { method: string; args: unknown[] }

function mockSupabase(opts: {
  shop?: Record<string, unknown> | null
  appointments?: Candidate[]
  appointmentsError?: { message: string } | null
  filters?: Filter[]
}): SupabaseClient {
  const filters = opts.filters ?? []
  const shopRow =
    opts.shop === undefined
      ? {
          id: "shop-1",
          timezone: "UTC",
          settings: {},
          aurinko_account_id: null,
          aurinko_access_token_enc: null,
          aurinko_token_expires_at: null,
        }
      : opts.shop
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "gte", "lt", "lte", "order", "limit"]) {
        chain[m] = (...args: unknown[]) => {
          filters.push({ method: `${table}.${m}`, args })
          return chain
        }
      }
      chain.maybeSingle = () =>
        Promise.resolve({
          data: table === "shops" ? shopRow : null,
          error: null,
        })
      // The appointments query resolves by awaiting the chain itself.
      chain.then = (
        resolve: (v: { data: unknown; error: unknown }) => unknown
      ) =>
        Promise.resolve(
          resolve({
            data: table === "appointments" ? (opts.appointments ?? []) : [],
            error: table === "appointments" ? (opts.appointmentsError ?? null) : null,
          })
        )
      return chain
    },
  } as unknown as SupabaseClient
}

const RANGE = { start: "2026-08-10T11:00:00Z", end: "2026-08-10T13:00:00Z" }

describe("checkAvailability", () => {
  it("no conflict → available, calendar unchecked (not connected) — still answers", async () => {
    const supabase = mockSupabase({ appointments: [] })
    const result = await checkAvailability(supabase, "shop-1", RANGE)
    expect(result.available).toBe(true)
    expect(result.conflicts).toEqual([])
    expect(result.calendar).toBe("unchecked")
    expect(result.calendarUncheckedReason).toBe("not_connected")
  })

  it("overlapping appointment → structured conflict payload", async () => {
    const supabase = mockSupabase({ appointments: [candidate({ id: "appt-1" })] })
    const result = await checkAvailability(supabase, "shop-1", RANGE)
    expect(result.available).toBe(false)
    expect(result.conflicts.some((c) => c.source === "appointment" && c.id === "appt-1")).toBe(
      true
    )
  })

  it("scopes every query to the shop (tenant isolation is explicit)", async () => {
    const filters: Filter[] = []
    const supabase = mockSupabase({ appointments: [], filters })
    await checkAvailability(supabase, "shop-1", RANGE)
    expect(filters).toContainEqual({
      method: "appointments.eq",
      args: ["shop_id", "shop-1"],
    })
    expect(filters).toContainEqual({ method: "shops.eq", args: ["id", "shop-1"] })
  })

  it("reschedule: excludes itself but another appointment still conflicts", async () => {
    const supabase = mockSupabase({
      appointments: [candidate({ id: "self" }), candidate({ id: "other" })],
    })
    const result = await checkAvailability(supabase, "shop-1", {
      ...RANGE,
      excludeAppointmentId: "self",
    })
    expect(result.excludedAppointmentId).toBe("self")
    const apptConflicts = result.conflicts.filter((c) => c.source === "appointment")
    expect(apptConflicts.map((c) => c.id)).toEqual(["other"])
  })

  it("reschedule: the appointment's own mirrored calendar event is not a conflict", async () => {
    mockedGetToken.mockResolvedValue("token-1")
    mockedListEvents.mockResolvedValue([
      {
        id: "ev-self",
        subject: "Detail",
        start: "2026-08-10T11:00:00Z",
        end: "2026-08-10T12:00:00Z",
        location: null,
      },
    ])
    const supabase = mockSupabase({
      appointments: [candidate({ id: "self", aurinko_event_id: "ev-self" })],
    })
    const result = await checkAvailability(supabase, "shop-1", {
      ...RANGE,
      excludeAppointmentId: "self",
    })
    expect(result.calendar).toBe("checked")
    expect(result.conflicts.filter((c) => c.source === "calendar")).toEqual([])
  })

  it("override metadata is echoed and NEVER disables detection", async () => {
    const override: ConflictOverride = {
      by: "owner-1",
      at: "2026-08-01T00:00:00Z",
      conflicts: ["appointment:appt-1"],
      reason: "Owner double-stacked on purpose",
    }
    const supabase = mockSupabase({ appointments: [candidate({ id: "appt-1" })] })
    const result = await checkAvailability(supabase, "shop-1", {
      ...RANGE,
      override,
    })
    expect(result.available).toBe(false)
    expect(result.conflicts.length).toBeGreaterThan(0)
    expect(result.override).toEqual(override)
  })

  it("invalid time range throws (real error, not 'busy')", async () => {
    const supabase = mockSupabase({ appointments: [] })
    await expect(
      checkAvailability(supabase, "shop-1", {
        start: "2026-08-10T13:00:00Z",
        end: "2026-08-10T11:00:00Z",
      })
    ).rejects.toThrow(/invalid range/)
    await expect(
      checkAvailability(supabase, "shop-1", { start: "garbage", end: RANGE.end })
    ).rejects.toThrow(/invalid start/)
  })

  it("appointments query failure throws — never guesses 'available'", async () => {
    const supabase = mockSupabase({
      appointments: [],
      appointmentsError: { message: "boom" },
    })
    await expect(checkAvailability(supabase, "shop-1", RANGE)).rejects.toThrow(
      /appointments query failed/
    )
  })

  it("calendar fetch throwing degrades to unchecked with a log — appointments still checked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockedGetToken.mockResolvedValue("token-1")
    mockedListEvents.mockRejectedValue(new Error("Aurinko 500"))
    const supabase = mockSupabase({ appointments: [candidate({ id: "appt-1" })] })
    const result = await checkAvailability(supabase, "shop-1", RANGE)
    expect(result.calendar).toBe("unchecked")
    expect(result.calendarUncheckedReason).toBe("error")
    expect(result.conflicts.some((c) => c.source === "appointment")).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[availability] calendar fetch failed"),
      expect.anything()
    )
  })

  it("calendar fetch timing out degrades to unchecked (bounded — booking can't hang)", async () => {
    mockedGetToken.mockResolvedValue("token-1")
    mockedListEvents.mockImplementation(
      () => new Promise(() => {}) // never resolves
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const supabase = mockSupabase({ appointments: [] })
    const result = await checkAvailability(supabase, "shop-1", {
      ...RANGE,
      calendarTimeoutMs: 10,
    })
    expect(result.calendar).toBe("unchecked")
    expect(result.calendarUncheckedReason).toBe("timeout")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("timed out")
    )
  })

  it("connected calendar with an overlapping foreign event → calendar conflict, checked", async () => {
    mockedGetToken.mockResolvedValue("token-1")
    mockedListEvents.mockResolvedValue([
      {
        id: "ev-1",
        subject: "Dentist",
        start: "2026-08-10T12:00:00Z",
        end: "2026-08-10T14:00:00Z",
        location: null,
      },
    ])
    const supabase = mockSupabase({ appointments: [] })
    const result = await checkAvailability(supabase, "shop-1", RANGE)
    expect(result.calendar).toBe("checked")
    expect(result.conflicts.map((c) => c.source)).toEqual(["calendar"])
  })

  it("multi-day proposal conflicts with a mid-span appointment", async () => {
    const supabase = mockSupabase({
      appointments: [candidate({ id: "mid", scheduled_at: "2026-08-11T15:00:00Z" })],
    })
    const result = await checkAvailability(supabase, "shop-1", {
      start: "2026-08-10T11:00:00Z",
      end: "2026-08-12T13:00:00Z",
    })
    expect(
      result.conflicts.some((c) => c.source === "appointment" && c.id === "mid")
    ).toBe(true)
  })

  it("result is deterministic: conflicts sorted by source, start, id", async () => {
    const supabase = mockSupabase({
      appointments: [
        candidate({ id: "b", scheduled_at: "2026-08-10T11:30:00Z" }),
        candidate({ id: "a", scheduled_at: "2026-08-10T11:30:00Z" }),
      ],
    })
    const result = await checkAvailability(supabase, "shop-1", RANGE)
    const apptIds = result.conflicts
      .filter((c) => c.source === "appointment")
      .map((c) => c.id)
    expect(apptIds).toEqual(["a", "b"])
  })
})
