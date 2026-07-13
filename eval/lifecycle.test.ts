import { describe, it, expect } from "vitest"

import {
  ACTIVE_WITHIN_DAYS,
  LAPSED_AFTER_DAYS,
  deriveLifecycle,
  lastServiceEvidenceMs,
  type LifecycleEvidence,
} from "@/lib/lifecycle"

/**
 * Tier 1 — pure. Locks the nightly lifecycle rule (spec §C1.3):
 * serviced <180d = active · 180–365d = at_risk · >365d = lapsed, with the
 * documented carve-outs (maintenance untouched, won_back preserved while
 * fresh, no evidence = no change). Code, not LLM (locked principle #1).
 */

const NOW = Date.parse("2026-07-08T12:00:00Z")
const DAY_MS = 24 * 60 * 60 * 1000

const servicedDaysAgo = (days: number): LifecycleEvidence => ({
  last_service_at: new Date(NOW - days * DAY_MS).toISOString(),
  last_visit_at: null,
  last_transaction_at: null,
})

const NO_EVIDENCE: LifecycleEvidence = {
  last_service_at: null,
  last_visit_at: null,
  last_transaction_at: null,
}

describe("lastServiceEvidenceMs", () => {
  it("takes the latest of the three evidence columns", () => {
    const ms = lastServiceEvidenceMs({
      last_service_at: "2026-01-01T00:00:00Z",
      last_visit_at: "2026-05-01T00:00:00Z",
      last_transaction_at: "2025-06-01T00:00:00Z",
    })
    expect(ms).toBe(Date.parse("2026-05-01T00:00:00Z"))
  })

  it("ignores unparseable values and returns null when nothing usable", () => {
    expect(lastServiceEvidenceMs(NO_EVIDENCE)).toBeNull()
    expect(
      lastServiceEvidenceMs({
        last_service_at: "not a date",
        last_visit_at: null,
        last_transaction_at: null,
      })
    ).toBeNull()
  })
})

describe("deriveLifecycle — the recency rule", () => {
  it("serviced <180d → active", () => {
    expect(deriveLifecycle("lapsed", servicedDaysAgo(30), NOW)).toBe("active")
    expect(deriveLifecycle("at_risk", servicedDaysAgo(179), NOW)).toBe("active")
  })

  it("180–365d silent → at_risk", () => {
    expect(deriveLifecycle("active", servicedDaysAgo(ACTIVE_WITHIN_DAYS), NOW)).toBe(
      "at_risk"
    )
    expect(deriveLifecycle("active", servicedDaysAgo(300), NOW)).toBe("at_risk")
  })

  it(">365d → lapsed", () => {
    expect(deriveLifecycle("active", servicedDaysAgo(LAPSED_AFTER_DAYS + 1), NOW)).toBe(
      "lapsed"
    )
    expect(deriveLifecycle("at_risk", servicedDaysAgo(730), NOW)).toBe("lapsed")
  })

  it("a serviced lead graduates to active", () => {
    expect(deriveLifecycle("lead", servicedDaysAgo(10), NOW)).toBe("active")
  })
})

describe("deriveLifecycle — carve-outs", () => {
  it("no service evidence → unchanged (a lead stays a lead)", () => {
    expect(deriveLifecycle("lead", NO_EVIDENCE, NOW)).toBe("lead")
    expect(deriveLifecycle("active", NO_EVIDENCE, NOW)).toBe("active")
  })

  it("maintenance is owner-managed — recency never overrides it", () => {
    expect(deriveLifecycle("maintenance", servicedDaysAgo(500), NOW)).toBe(
      "maintenance"
    )
    expect(deriveLifecycle("maintenance", NO_EVIDENCE, NOW)).toBe("maintenance")
  })

  it("won_back keeps its label while fresh, then ages normally", () => {
    expect(deriveLifecycle("won_back", servicedDaysAgo(30), NOW)).toBe("won_back")
    expect(deriveLifecycle("won_back", servicedDaysAgo(200), NOW)).toBe("at_risk")
    expect(deriveLifecycle("won_back", servicedDaysAgo(400), NOW)).toBe("lapsed")
  })
})
