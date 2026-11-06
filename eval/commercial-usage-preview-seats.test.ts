import { describe, expect, it } from "vitest"

import {
  APPROVED_COMMERCIAL_CATALOG_VERSION,
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"
import type { MembershipEvidence, MembershipEvidenceEvent } from "@/lib/commercial-seat-proration"
import {
  previewCommercialPeriod,
  type CommercialPeriodPreview,
  type EvidenceFact,
  type PreviewInput,
} from "@/lib/commercial-usage-preview"

const START = "2026-11-01T00:00:00Z"
const END = "2026-12-01T00:00:00Z"
const BEFORE = "2026-09-01T00:00:00Z"
let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

const outcome = (metric: string, workflowKey: string): EvidenceFact => ({
  id: id(),
  catalogVersion: APPROVED_COMMERCIAL_CATALOG_VERSION,
  metric,
  quantity: "1",
  workflowKey,
  wholesaleUnitCostCents: null,
  wholesaleBasis: null,
  recognizedAt: "2026-11-05T12:00:00Z",
  recordedAt: "2026-11-05T12:00:00Z",
})
const sms = (quantity: string, cost: string | null): EvidenceFact => ({
  ...outcome("sms_segment", ""),
  workflowKey: null,
  quantity,
  wholesaleUnitCostCents: cost,
  wholesaleBasis: cost === null ? null : "provider_reported",
})

let seq = 0
const member = (userId: string, at: string, billable: boolean): MembershipEvidenceEvent => ({
  id: `m-${++seq}`,
  shopSeq: seq,
  userId,
  kind: "change",
  newBillable: billable,
  effectiveAt: at,
  recordedAt: at,
})
const team = (extra: number): MembershipEvidenceEvent[] => [
  member("owner", BEFORE, true),
  member("manager", BEFORE, true),
  member("staff", BEFORE, true),
  ...Array.from({ length: extra }, (_, i) => member(`extra-${i}`, BEFORE, true)),
]
const covered = (events: MembershipEvidenceEvent[], coveredFrom = BEFORE): MembershipEvidence => ({
  status: "evidence",
  coverage: { coveredFrom, basis: "migration_snapshot", recordedAt: BEFORE },
  events,
})

const preview = (facts: EvidenceFact[], extra: Partial<PreviewInput> = {}): CommercialPeriodPreview =>
  previewCommercialPeriod({
    catalog: FOUNDER_APPROVED_COMMERCIAL_CATALOG,
    planKey: FOUNDER_PILOT_POLICY.planKey,
    windowStart: START,
    windowEnd: END,
    asOf: "2027-01-01T00:00:00Z",
    facts,
    corrections: [],
    priorWorkflowMetrics: {},
    ...extra,
  })

describe("seat proration in the period preview", () => {
  it("computes seat proration from complete coverage and assembles the invoice total", () => {
    const result = preview([outcome("qualified_lead", "wf-1")], { membership: covered(team(1)) })
    if (result.state !== "ok") throw new Error(JSON.stringify(result))
    expect(result.subscription.seatProration).toMatchObject({ state: "computed", roundedCents: 3900, extraSeatDays: 30 })
    expect(result.usage.totalCents).toBe(500)
    expect(result.subscription.invoiceTotal).toEqual({
      state: "available",
      baseCents: 19_900,
      seatCents: 3900,
      usageCents: 500,
      totalCents: 19_900 + 3900 + 500,
    })
  })

  it("three included operators add no seat charge but the total is still assembled", () => {
    const result = preview([], { membership: covered(team(0)) })
    if (result.state !== "ok") throw new Error("expected ok")
    expect(result.subscription.seatProration).toMatchObject({ state: "computed", roundedCents: 0 })
    expect(result.subscription.invoiceTotal).toMatchObject({ state: "available", seatCents: 0, usageCents: 0, totalCents: 19_900 })
  })

  it("leaves the usage calculation byte-for-byte unchanged by membership evidence", () => {
    const facts = [
      outcome("confirmed_appointment", "wf-a"),
      outcome("standard_digital_outcome", "wf-a"),
      sms("10", "2"),
    ]
    const without = preview(facts)
    for (const membership of [
      covered(team(2)),
      covered(team(0), "2026-11-15T00:00:00Z"), // gap
      { status: "unavailable", code: "membership_read_failed" } as const,
    ]) {
      const withSeats = preview(facts, { membership })
      expect(withSeats.state).toBe("ok")
      if (withSeats.state === "ok" && without.state === "ok") {
        expect(JSON.stringify(withSeats.usage)).toBe(JSON.stringify(without.usage))
      }
    }
  })

  it("keeps seat proration unavailable (and the invoice total unavailable) when coverage has a gap", () => {
    const result = preview([], { membership: covered(team(1), "2026-11-16T00:00:00Z") })
    if (result.state !== "ok") throw new Error("expected ok")
    expect(result.subscription.seatProration).toMatchObject({
      state: "seat_proration_unavailable",
      code: "coverage_gap",
      gap: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-16T00:00:00.000Z" },
    })
    expect(result.subscription.invoiceTotal).toEqual({ state: "unavailable", reason: "seat_proration_unavailable" })
    expect(JSON.stringify(result.subscription)).not.toContain("totalCents")
    expect(result.usage.totalCents).toBe(0) // usage is still shown
  })

  it("without membership evidence it behaves exactly as before PR B", () => {
    const result = preview([])
    if (result.state !== "ok") throw new Error("expected ok")
    expect(result.subscription.seatProration).toMatchObject({
      state: "seat_proration_unavailable",
      code: "no_membership_evidence",
    })
    expect(result.subscription.invoiceTotal).toEqual({ state: "unavailable", reason: "seat_proration_unavailable" })
  })

  it("never assembles a total while usage is cap-refused, unavailable or conflicted", () => {
    const membership = covered(team(1))
    const overCap = preview(Array.from({ length: 11 }, (_, i) => outcome("confirmed_appointment", `a-${i}`)), { membership })
    const missingCost = preview([sms("3", null)], { membership })
    const upgraded = preview([outcome("confirmed_appointment", "w")], {
      membership,
      priorWorkflowMetrics: { w: "standard_digital_outcome" },
    })
    expect([overCap.state, missingCost.state, upgraded.state]).toEqual(["cap_exceeded", "unavailable", "conflict"])
    const reasons = [overCap, missingCost, upgraded].map((r) => {
      if (r.state === "invalid") throw new Error("unexpected")
      return r.subscription.invoiceTotal
    })
    expect(reasons).toEqual([
      { state: "unavailable", reason: "usage_cap_exceeded" },
      { state: "unavailable", reason: "usage_unavailable" },
      { state: "unavailable", reason: "usage_conflict" },
    ])
    for (const result of [overCap, missingCost, upgraded]) {
      const json = JSON.stringify(result)
      // A refused or unavailable preview carries no assembled total of any kind.
      expect(json).not.toContain('"totalCents"')
      expect(json).not.toContain('"state":"available"')
    }
    // The seat component itself is still shown on its own.
    if (overCap.state !== "invalid") expect(overCap.subscription.seatProration.state).toBe("computed")
  })

  it("invalid usage evidence stays invalid and carries no subscription total", () => {
    const result = preview([outcome("agent_run", "w")], { membership: covered(team(1)) })
    expect(result).toMatchObject({ state: "invalid" })
    expect(JSON.stringify(result)).not.toMatch(/totalCents|roundedCents/)
  })

  it("a seat gap never turns into a zero seat charge in the total", () => {
    const result = preview([outcome("qualified_lead", "wf")], { membership: covered(team(3), "2027-06-01T00:00:00Z") })
    if (result.state !== "ok") throw new Error("expected ok")
    expect(result.subscription.invoiceTotal.state).toBe("unavailable")
  })

  it("uses the same window for usage and seats (a non-midnight window keeps usage, loses seats)", () => {
    const result = preview([outcome("qualified_lead", "wf")], {
      membership: covered(team(1)),
      windowStart: "2026-11-01T06:00:00Z",
    })
    if (result.state !== "ok") throw new Error("expected ok")
    expect(result.usage.totalCents).toBe(500)
    expect(result.subscription.seatProration).toMatchObject({ code: "period_not_utc_day_aligned" })
  })

  it("an open period (not yet closed at as-of) keeps usage and withholds seats", () => {
    const result = preview([], { membership: covered(team(1)), asOf: "2026-11-20T00:00:00Z" })
    if (result.state !== "ok") throw new Error("expected ok")
    expect(result.subscription.seatProration).toMatchObject({
      code: "period_not_closed",
      gap: { start: "2026-11-20T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" },
    })
  })
})
