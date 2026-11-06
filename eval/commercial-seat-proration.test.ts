import { describe, expect, it } from "vitest"

import {
  computeSeatProration,
  parseMicros,
  type MembershipEvidence,
  type MembershipEvidenceEvent,
  type SeatProration,
} from "@/lib/commercial-seat-proration"

const NOV = { periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-12-01T00:00:00Z" } // 30 days
const OCT = { periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z" } // 31 days
const BEFORE = "2026-09-01T00:00:00Z"
const AS_OF = "2027-01-01T00:00:00Z"

let seq = 0
const ev = (
  userId: string,
  effectiveAt: string,
  newBillable: boolean,
  patch: Partial<MembershipEvidenceEvent> = {}
): MembershipEvidenceEvent => ({
  id: `ev-${++seq}`,
  shopSeq: seq,
  userId,
  kind: "change",
  newBillable,
  effectiveAt,
  recordedAt: effectiveAt,
  ...patch,
})
const evidence = (
  events: MembershipEvidenceEvent[],
  coveredFrom = BEFORE,
  recordedAt = BEFORE
): MembershipEvidence => ({
  status: "evidence",
  coverage: { coveredFrom, basis: "migration_snapshot", recordedAt },
  events,
})
const compute = (
  events: MembershipEvidenceEvent[],
  patch: Partial<Parameters<typeof computeSeatProration>[0]> = {}
): SeatProration =>
  computeSeatProration({
    includedSeats: 3,
    extraSeatCents: 3900,
    ...NOV,
    asOf: AS_OF,
    evidence: evidence(events),
    ...patch,
  })

function computed(result: SeatProration) {
  if (result.state !== "computed") throw new Error(`expected computed, got ${JSON.stringify(result)}`)
  return result
}
/** Three standing operators (owner, manager, staff) from before the period. */
const base = () => [
  ev("owner", BEFORE, true, { kind: "snapshot" }),
  ev("manager", BEFORE, true, { kind: "snapshot" }),
  ev("staff", BEFORE, true, { kind: "snapshot" }),
]

describe("included seats and distinct users", () => {
  it("charges nothing for the three included operators", () => {
    const result = computed(compute(base()))
    expect(result.extraSeatDays).toBe(0)
    expect(result.roundedCents).toBe(0)
    expect(result.days).toHaveLength(30)
    expect(result.days.every((d) => d.billableUsers === 3 && d.extraSeats === 0)).toBe(true)
  })

  it("charges one extra seat for the whole month exactly once", () => {
    const result = computed(compute([...base(), ev("fourth", BEFORE, true)]))
    expect(result.extraSeatDays).toBe(30)
    expect(result.numerator).toBe(30 * 3900)
    expect(result.denominator).toBe(30)
    expect(result.roundedCents).toBe(3900)
  })

  it("honors the plan's included-seat count and price", () => {
    const result = computed(compute([...base(), ev("fourth", BEFORE, true)], { includedSeats: 4, extraSeatCents: 5000 }))
    expect(result.roundedCents).toBe(0)
    expect(computed(compute([...base(), ev("fourth", BEFORE, true)], { includedSeats: 2, extraSeatCents: 5000 })).roundedCents).toBe(
      10000
    )
  })

  it("counts distinct users, never events: repeated events for one user are one seat", () => {
    const events = [
      ...base(),
      ev("fourth", BEFORE, true),
      ev("fourth", "2026-11-05T09:00:00Z", true), // e.g. a role change keeps them billable
      ev("fourth", "2026-11-09T09:00:00Z", true),
    ]
    const result = computed(compute(events))
    expect(result.days.every((d) => d.billableUsers === 4)).toBe(true)
    expect(result.extraSeatDays).toBe(30)
  })

  it("never counts non-billable state: inactive, revoked or removed users add nothing", () => {
    const events = [...base(), ev("gone", BEFORE, false), ev("pending-like", BEFORE, false)]
    const result = computed(compute(events))
    expect(result.extraSeatDays).toBe(0)
  })
})

describe("exact UTC seat-days", () => {
  it("mid-period activation counts from the activation day (any instant of the day)", () => {
    // 4th operator starts Nov 16 at 12:00 -> Nov 16..30 = 15 seat-days.
    const result = computed(compute([...base(), ev("fourth", "2026-11-16T12:00:00Z", true)]))
    expect(result.extraSeatDays).toBe(15)
    expect(result.roundedCents).toBe(1950)
    expect(result.days.find((d) => d.date === "2026-11-15")?.extraSeats).toBe(0)
    expect(result.days.find((d) => d.date === "2026-11-16")?.extraSeats).toBe(1)
  })

  it("revocation: the user still counts for the day they were active, not after", () => {
    // Active from before, revoked Nov 10 12:00 -> Nov 1..10 inclusive = 10 seat-days.
    const result = computed(compute([...base(), ev("fourth", BEFORE, true), ev("fourth", "2026-11-10T12:00:00Z", false)]))
    expect(result.extraSeatDays).toBe(10)
  })

  it("an event exactly at UTC midnight belongs to the new day", () => {
    const atMidnight = computed(compute([...base(), ev("fourth", BEFORE, true), ev("fourth", "2026-11-10T00:00:00Z", false)]))
    expect(atMidnight.extraSeatDays).toBe(9) // Nov 10 has no active instant
    const justAfter = computed(compute([...base(), ev("fourth", BEFORE, true), ev("fourth", "2026-11-10T00:00:00.000001Z", false)]))
    expect(justAfter.extraSeatDays).toBe(10) // active for one microsecond of Nov 10
  })

  it("reactivation counts both stretches without double counting the gap", () => {
    const events = [
      ...base(),
      ev("fourth", BEFORE, true),
      ev("fourth", "2026-11-06T12:00:00Z", false), // counts Nov 1..6 = 6
      ev("fourth", "2026-11-20T08:00:00Z", true), // counts Nov 20..30 = 11
    ]
    expect(computed(compute(events)).extraSeatDays).toBe(17)
  })

  it("role change between billable roles does not change the count", () => {
    const events = [...base(), ev("manager", "2026-11-12T10:00:00Z", true), ev("staff", "2026-11-12T10:00:00Z", true)]
    const result = computed(compute(events))
    expect(result.days.every((d) => d.billableUsers === 3)).toBe(true)
    expect(result.roundedCents).toBe(0)
  })

  it("a change from billable to non-billable and back on the same day is ONE seat-day", () => {
    const events = [
      ...base(),
      ev("fourth", "2026-11-08T10:00:00Z", true),
      ev("fourth", "2026-11-08T10:05:00Z", false),
    ]
    const result = computed(compute(events))
    expect(result.extraSeatDays).toBe(1)
    expect(result.days.find((d) => d.date === "2026-11-08")).toMatchObject({ billableUsers: 4, extraSeats: 1 })
  })

  it("activate then deactivate then activate within a day is still one seat-day", () => {
    const events = [
      ...base(),
      ev("fourth", "2026-11-08T01:00:00Z", true),
      ev("fourth", "2026-11-08T02:00:00Z", false),
      ev("fourth", "2026-11-08T03:00:00Z", true),
      ev("fourth", "2026-11-08T04:00:00Z", false),
    ]
    expect(computed(compute(events)).extraSeatDays).toBe(1)
  })

  it("two extra users on different days are summed per day", () => {
    const events = [
      ...base(),
      ev("fourth", "2026-11-26T00:00:00Z", true), // Nov 26..30 = 5
      ev("fifth", "2026-11-28T12:00:00Z", true), // Nov 28..30 = 3 (+ fourth already extra)
    ]
    // days 26,27: 4 users -> 1 extra each = 2; days 28,29,30: 5 users -> 2 extra each = 6.
    const result = computed(compute(events))
    expect(result.extraSeatDays).toBe(8)
    expect(result.roundedCents).toBe(Math.floor((2 * 8 * 3900 + 30) / 60))
  })

  it("a later-recorded event at the same instant wins; an earlier tied event does not count", () => {
    const events = [
      ...base(),
      ev("fourth", "2026-11-08T10:00:00Z", true),
      ev("fourth", "2026-11-08T10:00:00Z", false), // same instant, recorded later: user never active
    ]
    expect(computed(compute(events)).extraSeatDays).toBe(0)
  })

  it("orders same-millisecond events by exact microseconds", () => {
    const events = [
      ...base(),
      ev("fourth", "2026-11-08T10:00:00.000002Z", false, { shopSeq: 99 }),
      ev("fourth", "2026-11-08T10:00:00.000001Z", true, { shopSeq: 100 }),
    ]
    // true at .000001, false at .000002 (by time, not by seq): active for one microsecond.
    expect(computed(compute(events)).extraSeatDays).toBe(1)
  })

  it("applies explicit corrections as a compensating state from their instant", () => {
    const events = [
      ...base(),
      ev("fourth", BEFORE, false),
      ev("fourth", "2026-11-10T00:00:00Z", true, { kind: "correction" }), // was billable from Nov 10
      ev("fourth", "2026-11-15T12:00:00Z", false), // later recorded real event ends it
    ]
    expect(computed(compute(events)).extraSeatDays).toBe(6) // Nov 10..15
  })

  it("is independent of the order the evidence is supplied in", () => {
    const events = [
      ...base(),
      ev("fourth", "2026-11-03T08:00:00Z", true),
      ev("fourth", "2026-11-09T08:00:00Z", false),
      ev("fifth", "2026-11-15T08:00:00Z", true),
    ]
    const forward = JSON.stringify(compute(events))
    expect(JSON.stringify(compute([...events].reverse()))).toBe(forward)
    expect(JSON.stringify(compute([events[4], events[0], events[3], events[1], events[2], events[5]]))).toBe(forward)
  })

  it("understands timestamps in any UTC offset", () => {
    expect(parseMicros("2026-11-04T19:00:00-05:00")).toBe(parseMicros("2026-11-05T00:00:00Z"))
    expect(parseMicros("2026-11-05T00:00:00+00:00")).toBe(parseMicros("2026-11-05T00:00:00Z"))
    expect(parseMicros("2026-11-05T00:00:00.5Z")).toBe(parseMicros("2026-11-05T00:00:00.500000Z"))
    expect(parseMicros("not a time")).toBeNull()
    const result = computed(compute([...base(), ev("fourth", "2026-11-15T19:00:00-05:00", true)])) // = Nov 16 00:00Z
    expect(result.extraSeatDays).toBe(15)
  })
})

describe("rounding once, half-up", () => {
  it("rounds the period total once, not each day", () => {
    // 31-day month, 4 extra seat-days: 4 * 3900 / 31 = 503.2258 -> 503 (per-day rounding would give 504).
    const events = [
      ...base(),
      ev("fourth", "2026-10-10T00:00:00Z", true),
      ev("fourth", "2026-10-14T00:00:00Z", false),
    ]
    const result = computed(compute(events, OCT))
    expect(result.extraSeatDays).toBe(4)
    expect(result.numerator).toBe(15_600)
    expect(result.denominator).toBe(31)
    expect(result.roundedCents).toBe(503)
    expect(Math.round(3900 / 31) * 4).toBe(504)
  })

  it("rounds an exact half up", () => {
    // 1 cent per extra seat over a 2-day period, 1 extra seat-day -> exactly 0.5 -> 1.
    const result = computed(
      compute([...base(), ev("fourth", "2026-11-01T12:00:00Z", true), ev("fourth", "2026-11-02T00:00:00Z", false)], {
        periodEnd: "2026-11-03T00:00:00Z",
        extraSeatCents: 1,
      })
    )
    expect(result.extraSeatDays).toBe(1)
    expect(result.numerator).toBe(1)
    expect(result.denominator).toBe(2)
    expect(result.roundedCents).toBe(1)
  })

  it("rounds just below a half down and just above up", () => {
    const run = (cents: number, days: number) =>
      computed(
        compute([...base(), ev("fourth", BEFORE, true)], {
          periodEnd: new Date(Date.parse("2026-11-01T00:00:00Z") + days * 86_400_000).toISOString(),
          extraSeatCents: cents,
        })
      ).roundedCents
    expect(run(1, 3)).toBe(1) // 3 seat-days * 1 / 3 = 1
    expect(run(7, 4)).toBe(7) // 28/4 = 7
    // 5 days, 1 extra seat-day only: 2/5 = 0.4 -> 0 ; 3/5 = 0.6 -> 1
    const oneDay = (cents: number) =>
      computed(
        compute([...base(), ev("fourth", "2026-11-05T00:00:00Z", true), ev("fourth", "2026-11-06T00:00:00Z", false)], {
          periodEnd: "2026-11-06T00:00:00Z",
          extraSeatCents: cents,
        })
      ).roundedCents
    expect(oneDay(2)).toBe(0)
    expect(oneDay(3)).toBe(1)
  })
})

describe("month lengths and half-open rollover", () => {
  it.each([
    ["February 2027", "2027-02-01T00:00:00Z", "2027-03-01T00:00:00Z", 28],
    ["February 2028 (leap)", "2028-02-01T00:00:00Z", "2028-03-01T00:00:00Z", 29],
    ["November", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", 30],
    ["December", "2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z", 31],
  ])("%s has %i calendar days and prices a full extra seat at exactly $39", (_name, start, end, days) => {
    const result = computed(
      computeSeatProration({
        includedSeats: 3,
        extraSeatCents: 3900,
        periodStart: start,
        periodEnd: end,
        asOf: "2030-01-01T00:00:00Z",
        evidence: evidence([...base(), ev("fourth", BEFORE, true)]),
      })
    )
    expect(result.daysInPeriod).toBe(days)
    expect(result.days).toHaveLength(days)
    expect(result.denominator).toBe(days)
    expect(result.extraSeatDays).toBe(days)
    expect(result.roundedCents).toBe(3900)
  })

  it("never double-counts a user who joins exactly at the rollover instant", () => {
    const joinsAtRollover = [...base(), ev("fourth", "2026-12-01T00:00:00Z", true)]
    const november = computed(compute(joinsAtRollover))
    const december = computed(
      computeSeatProration({
        includedSeats: 3,
        extraSeatCents: 3900,
        periodStart: "2026-12-01T00:00:00Z",
        periodEnd: "2027-01-01T00:00:00Z",
        asOf: AS_OF,
        evidence: evidence(joinsAtRollover),
      })
    )
    expect(november.extraSeatDays).toBe(0)
    expect(december.extraSeatDays).toBe(31)
    // A user leaving exactly at the rollover is in November only.
    const leaves = [...base(), ev("fourth", BEFORE, true), ev("fourth", "2026-12-01T00:00:00Z", false)]
    expect(computed(compute(leaves)).extraSeatDays).toBe(30)
    const decemberLeaves = computed(
      computeSeatProration({
        includedSeats: 3,
        extraSeatCents: 3900,
        periodStart: "2026-12-01T00:00:00Z",
        periodEnd: "2027-01-01T00:00:00Z",
        asOf: AS_OF,
        evidence: evidence(leaves),
      })
    )
    expect(decemberLeaves.extraSeatDays).toBe(0)
  })

  it("ignores events at or after the period end", () => {
    const result = computed(compute([...base(), ev("fourth", "2026-12-01T00:00:00Z", true), ev("fifth", "2027-02-01T00:00:00Z", true)]))
    expect(result.extraSeatDays).toBe(0)
  })
})

describe("incomplete history is unavailable, never zero", () => {
  const isUnavailable = (result: SeatProration) => {
    expect(result.state).toBe("seat_proration_unavailable")
    expect(JSON.stringify(result)).not.toMatch(/roundedCents|extraSeatDays|numerator/)
    return result as Extract<SeatProration, { state: "seat_proration_unavailable" }>
  }

  it("without any evidence", () => {
    expect(isUnavailable(compute([], { evidence: undefined })).code).toBe("no_membership_evidence")
  })

  it("when evidence could not be read or was malformed", () => {
    expect(isUnavailable(compute([], { evidence: { status: "unavailable", code: "membership_read_failed" } })).code).toBe(
      "membership_read_failed"
    )
    expect(
      isUnavailable(compute([], { evidence: { status: "unavailable", code: "malformed_membership_evidence" } })).code
    ).toBe("malformed_membership_evidence")
    expect(
      isUnavailable(compute([{ ...ev("u", BEFORE, true), effectiveAt: "garbage" }])).code
    ).toBe("malformed_membership_evidence")
  })

  it("when no coverage has been recorded: the whole period is the gap", () => {
    const result = isUnavailable(compute([], { evidence: { status: "evidence", coverage: null, events: [] } }))
    expect(result.code).toBe("no_coverage")
    expect(result.gap).toEqual({ start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" })
  })

  it("when coverage starts inside the period: the exact uncovered span is reported", () => {
    const result = isUnavailable(compute(base(), { evidence: evidence(base(), "2026-11-12T08:30:00Z") }))
    expect(result.code).toBe("coverage_gap")
    expect(result.gap).toEqual({ start: "2026-11-01T00:00:00.000Z", end: "2026-11-12T08:30:00.000Z" })
  })

  it("when coverage starts after the period ends: the gap is the whole period, not beyond it", () => {
    const result = isUnavailable(compute(base(), { evidence: evidence(base(), "2027-03-01T00:00:00Z") }))
    expect(result.gap).toEqual({ start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" })
  })

  it("coverage that was not yet recorded as of the evidence instant does not count", () => {
    const result = isUnavailable(
      compute(base(), { asOf: "2026-12-05T00:00:00Z", evidence: evidence(base(), BEFORE, "2026-12-20T00:00:00Z") })
    )
    expect(result.code).toBe("no_coverage")
  })

  it("coverage that begins exactly at the period start is complete", () => {
    expect(compute(base(), { evidence: evidence(base(), "2026-11-01T00:00:00Z") }).state).toBe("computed")
  })

  it("when the period has not closed as of the evidence instant", () => {
    const result = isUnavailable(compute(base(), { asOf: "2026-11-20T06:00:00Z" }))
    expect(result.code).toBe("period_not_closed")
    expect(result.gap).toEqual({ start: "2026-11-20T06:00:00.000Z", end: "2026-12-01T00:00:00.000Z" })
  })

  it("when the period is not UTC-midnight aligned or not a valid window", () => {
    expect(isUnavailable(compute(base(), { periodStart: "2026-11-01T06:00:00Z" })).code).toBe("period_not_utc_day_aligned")
    expect(isUnavailable(compute(base(), { periodEnd: "2026-12-01T00:00:01Z" })).code).toBe("period_not_utc_day_aligned")
    expect(isUnavailable(compute(base(), { periodStart: NOV.periodEnd, periodEnd: NOV.periodStart })).code).toBe("invalid_period")
    expect(isUnavailable(compute(base(), { periodEnd: "2027-03-01T00:00:00Z" })).code).toBe("invalid_period")
    expect(isUnavailable(compute(base(), { periodStart: "2026-11-01" })).code).toBe("invalid_period")
  })

  it("an empty team with full coverage is a real zero, distinct from unavailable", () => {
    const result = computed(compute([]))
    expect(result.extraSeatDays).toBe(0)
    expect(result.roundedCents).toBe(0)
  })

  it("evidence recorded after the as-of instant does not exist yet", () => {
    const late = ev("fourth", "2026-11-05T00:00:00Z", true, { recordedAt: "2027-02-01T00:00:00Z" })
    expect(computed(compute([...base(), late])).extraSeatDays).toBe(0)
  })
})
