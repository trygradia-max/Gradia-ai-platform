import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"

import {
  buildCustomerFacts,
  deterministicSummary,
  type CustomerFactInput,
} from "@/lib/whisper-summary"

/**
 * C6b — summary grounding (fixture spot-checks per the run rail). The fact
 * pack is pure code over DB rows; every line asserted here is derivable
 * from the input and nothing else. The worker prompt is source-locked to
 * "ONLY the facts listed", and the deterministic fallback IS the fact line.
 */

const BASE: CustomerFactInput = {
  name: "Marcus Webb",
  completedJobsCount: 3,
  lifetimeValueCents: 184000,
  lastServiceAt: "2025-08-15T00:00:00Z",
  vehicles: ["White Tesla Model 3"],
  upcomingAppointmentAt: null,
  outstandingQuotesCount: 1,
  outstandingQuotesCents: 22000,
  inboundByChannel: { sms: 9, voice: 2 },
  lastInboundAt: "2026-06-20T00:00:00Z",
  doNotContact: false,
}

describe("buildCustomerFacts — the spec's example, derived not invented", () => {
  it('produces "3 jobs, $1,840 LTV, coating Aug 2025, prefers text"-class facts', () => {
    const facts = buildCustomerFacts(BASE)
    expect(facts).toContain("3 completed jobs")
    expect(facts).toContain("$1840 lifetime value")
    expect(facts).toContain("last serviced Aug 2025")
    expect(facts).toContain("drives a White Tesla Model 3")
    expect(facts).toContain("1 open quote worth $220")
    expect(facts).toContain("prefers text")
  })

  it("never emits a fact whose input is absent", () => {
    const facts = buildCustomerFacts({
      name: null,
      completedJobsCount: 0,
      lifetimeValueCents: 0,
      lastServiceAt: null,
      vehicles: [],
      upcomingAppointmentAt: null,
      outstandingQuotesCount: 0,
      outstandingQuotesCents: 0,
      inboundByChannel: {},
      lastInboundAt: null,
      doNotContact: false,
    })
    expect(facts).toEqual(["no completed jobs yet"])
  })

  it("surfaces do-not-contact — the one fact the owner must never miss", () => {
    const facts = buildCustomerFacts({ ...BASE, doNotContact: true })
    expect(facts).toContain("marked do-not-contact")
  })
})

describe("deterministic fallback", () => {
  it("joins the facts verbatim — zero room for invention", () => {
    expect(deterministicSummary(["3 completed jobs", "prefers text"])).toBe(
      "3 completed jobs · prefers text."
    )
    expect(deterministicSummary([])).toBe("Nothing on file yet.")
  })
})

describe("worker prompt is fact-locked (source lock)", () => {
  it("the system prompt forbids adding anything beyond the listed facts", () => {
    const src = readFileSync(
      new URL("../src/lib/whisper-summary.ts", import.meta.url),
      "utf8"
    )
    expect(src).toContain("use ONLY the facts listed")
    expect(src).toContain("never add, infer, estimate, or embellish")
  })
})
