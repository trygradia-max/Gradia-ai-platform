import { describe, it, expect } from "vitest"

import {
  buildLookupOutcome,
  dedupePeople,
  matchPeople,
  phoneFragment,
  type PersonRecord,
} from "@/lib/find-person"

/**
 * P0 golden fixtures (fix-pass 2026-07-13) — written BEFORE the tool per
 * the rail. Reproduces the production failure verbatim: lead "mike" exists
 * on the pipeline with a phone and NO interactions; the agent must find
 * him deterministically, and the outcomes (miss / hit / collision) are
 * decided by code with honest copy.
 */

// --- the seeded CRM state -----------------------------------------------------

const PEOPLE: PersonRecord[] = [
  {
    // THE production case: lead-only Mike, no interactions, phone on file.
    source: "lead",
    id: "lead-mike",
    customerId: null,
    name: "Mike Torres",
    phone: "+15550000201",
    email: null,
    vehicle: "'19 F-150 — black",
    stage: "new",
    note: "Walked in asking about ceramic",
    createdAt: "2026-06-11T00:00:00Z",
  },
  {
    // Customer-only record (no lead).
    source: "customer",
    id: "cust-sara",
    customerId: null,
    name: "Sara Kim",
    phone: "+15550000202",
    email: "sara@x.com",
    vehicle: "White Tesla Model 3",
    stage: null,
    note: null,
    createdAt: "2026-05-01T00:00:00Z",
  },
  {
    // Second Mike — the collision (different vehicle distinguishes them).
    source: "customer",
    id: "cust-mike2",
    customerId: null,
    name: "Mike Nguyen",
    phone: "+15550000203",
    email: null,
    vehicle: "'21 Civic — blue",
    stage: null,
    note: null,
    createdAt: "2026-04-01T00:00:00Z",
  },
]

// --- goldens -------------------------------------------------------------------

describe("the production case: lead-only mike, zero interactions", () => {
  it('"mike torres" resolves uniquely from the LEADS table, no memory needed', () => {
    const matches = matchPeople("mike torres", PEOPLE)
    const outcome = buildLookupOutcome("mike torres", matches)
    expect(outcome.outcome).toBe("one")
    if (outcome.outcome === "one") {
      expect(outcome.match.id).toBe("lead-mike")
      expect(outcome.match.source).toBe("lead")
      // NEVER ask for a phone when a unique name match exists.
      expect(outcome.say.toLowerCase()).not.toContain("phone number")
      expect(outcome.say).toContain("Mike Torres")
    }
  })

  it("a phone fragment finds him too", () => {
    const matches = matchPeople("0201", PEOPLE)
    expect(matches.map((m) => m.id)).toEqual(["lead-mike"])
    expect(matches[0].matchedOn).toBe("phone")
  })
})

describe("customer-only match", () => {
  it('"sara" resolves from customers', () => {
    const outcome = buildLookupOutcome("sara", matchPeople("sara", PEOPLE))
    expect(outcome.outcome).toBe("one")
    if (outcome.outcome === "one") expect(outcome.match.id).toBe("cust-sara")
  })
})

describe("two-mikes collision", () => {
  it("disambiguates with facts on file (vehicles), not a phone request", () => {
    const outcome = buildLookupOutcome("mike", matchPeople("mike", PEOPLE))
    expect(outcome.outcome).toBe("many")
    if (outcome.outcome === "many") {
      expect(outcome.matches).toHaveLength(2)
      expect(outcome.say).toContain("F-150")
      expect(outcome.say).toContain("Civic")
      expect(outcome.say.toLowerCase()).not.toContain("phone number")
    }
  })
})

describe("zero-match — the honest miss", () => {
  it("says it's a miss and offers the create; no invented infrastructure excuse", () => {
    const outcome = buildLookupOutcome("gary", matchPeople("gary", PEOPLE))
    expect(outcome.outcome).toBe("none")
    expect(outcome.say).toBe(
      'I don\'t see anyone matching "gary" in the CRM yet — want me to create the lead?'
    )
    for (const banned of ["connection", "network", "issue", "try again later"]) {
      expect(outcome.say.toLowerCase()).not.toContain(banned)
    }
  })
})

describe("lead+customer dedupe", () => {
  it("a lead linked to a customer is ONE person with merged facts", () => {
    const linked: PersonRecord[] = [
      {
        source: "customer",
        id: "cust-1",
        customerId: null,
        name: "Ada Lovelace",
        phone: "+15550000301",
        email: "ada@x.com",
        vehicle: null,
        stage: null,
        note: null,
        createdAt: null,
      },
      {
        source: "lead",
        id: "lead-1",
        customerId: "cust-1",
        name: "Ada Lovelace",
        phone: "+15550000301",
        email: null,
        vehicle: "2022 Tesla Model Y",
        stage: "quote_sent",
        note: null,
        createdAt: null,
      },
    ]
    const matches = dedupePeople(matchPeople("ada", linked))
    expect(matches).toHaveLength(1)
    expect(matches[0].source).toBe("customer") // customer identity wins
    expect(matches[0].vehicle).toBe("2022 Tesla Model Y") // lead facts carried
    expect(matches[0].stage).toBe("quote_sent")
  })
})

describe("phoneFragment", () => {
  it("needs 4+ digits and keeps the last 10", () => {
    expect(phoneFragment("mike")).toBeNull()
    expect(phoneFragment("021")).toBeNull()
    expect(phoneFragment("(555) 000-0201")).toBe("5550000201")
    expect(phoneFragment("+1 555 000 0201")).toBe("5550000201")
  })
})
