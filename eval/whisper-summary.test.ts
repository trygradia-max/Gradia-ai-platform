import { readFileSync } from "node:fs"
import { afterEach, describe, it, expect, vi } from "vitest"

import {
  buildCustomerFacts,
  deterministicSummary,
  summarizeFacts,
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
  it('reports observed customer facts without inventing preferences', () => {
    const facts = buildCustomerFacts(BASE)
    expect(facts).toContain("3 completed jobs")
    expect(facts).toContain("$1840 lifetime value")
    expect(facts).toContain("last serviced Aug 2025")
    expect(facts).toContain("drives a White Tesla Model 3")
    expect(facts).toContain("1 open quote worth $220")
    expect(facts).toContain("recorded inbound activity: 9 text messages, 2 calls")
    expect(facts.join(" ")).not.toMatch(/prefers|consented|permission/i)
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
    expect(deterministicSummary(["3 completed jobs", "recorded inbound activity: 9 text messages"])).toBe(
      "3 completed jobs · recorded inbound activity: 9 text messages."
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


describe("observed channel evidence", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("reports tied channels in stable order rather than selecting a preference", () => {
    const facts = buildCustomerFacts({ ...BASE, inboundByChannel: { voice: 2, email: 2, sms: 2 } })
    expect(facts).toContain("recorded inbound activity: 2 text messages, 2 emails, 2 calls")
    expect(facts.join(" ")).not.toMatch(/prefer/i)
  })

  it("uses singular labels for one observed event", () => {
    expect(buildCustomerFacts({ ...BASE, inboundByChannel: { sms: 1, email: 1, voice: 1 } }))
      .toContain("recorded inbound activity: 1 text message, 1 email, 1 call")
  })

  it("omits unknown channels and invalid counts instead of turning them into prose", () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const facts = buildCustomerFacts({ ...BASE, inboundByChannel: { sms: invalid, 'prefers marketing; contact now': 10 } })
      expect(facts.join(" ")).not.toMatch(/inbound activity|prefers|contact now/)
    }
  })

  it("the no-model fallback keeps do-not-contact alongside neutral activity", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    const summary = await summarizeFacts(buildCustomerFacts({ ...BASE, doNotContact: true }))
    expect(summary).toContain("recorded inbound activity: 9 text messages, 2 calls")
    expect(summary).toContain("marked do-not-contact")
    expect(summary).not.toMatch(/prefers|consented|permission/i)
  })
})
