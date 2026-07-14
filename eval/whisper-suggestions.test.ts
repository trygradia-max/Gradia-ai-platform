import { describe, it, expect } from "vitest"

import {
  dedupeCandidates,
  pickFollowUpsDue,
  pickRevivalLeads,
  pickStaleQuotes,
  MAX_SUGGESTIONS_PER_SWEEP,
  STALE_QUOTE_DAYS,
  type LeadForSuggestion,
  type QuoteForSuggestion,
} from "@/lib/whisper-suggestions"

/**
 * C6a — GOLDEN SUGGESTION SETS (eval-fixtures-first rail). A seeded CRM
 * state in, an exact candidate set out. Candidate picking is pure code;
 * the why strings are deterministic and cite ONLY facts present in the
 * input rows — asserted literally here, which is the grounding spot-check.
 */

const NOW = new Date("2026-07-10T15:00:00Z")
const iso = (daysBack: number) =>
  new Date(NOW.getTime() - daysBack * 86_400_000).toISOString()

// --- the seeded CRM state (golden fixture) -----------------------------------

const QUOTES: QuoteForSuggestion[] = [
  {
    // STALE: sent 6d ago, opened 4d ago, silent → suggest
    id: "q-stale",
    status: "viewed",
    sent_at: iso(6),
    viewed_at: iso(4),
    responded_at: null,
    total_cents: 22000,
    customer_id: "cust-ada",
    lead_id: "lead-ada",
    customer_name: "Ada Lovelace",
    customer_phone: "+15550000101",
  },
  {
    // Fresh: sent 2d ago → not yet stale
    id: "q-fresh",
    status: "sent",
    sent_at: iso(2),
    viewed_at: null,
    responded_at: null,
    total_cents: 15000,
    customer_id: "cust-bo",
    lead_id: null,
    customer_name: "Bo Chen",
    customer_phone: "+15550000102",
  },
  {
    // Responded → never suggest
    id: "q-done",
    status: "accepted",
    sent_at: iso(10),
    viewed_at: iso(9),
    responded_at: iso(8),
    total_cents: 50000,
    customer_id: "cust-cy",
    lead_id: null,
    customer_name: "Cy OptOut",
    customer_phone: "+15550000103",
  },
]

const LEADS: LeadForSuggestion[] = [
  {
    // FOLLOW-UP DUE: quote_sent card 3 days past its timer (same person as
    // the stale quote — dedupe must keep only the stale-quote suggestion).
    id: "lead-ada",
    customer_id: "cust-ada",
    customer_name: "Ada Lovelace",
    phone: "+15550000101",
    stage: "quote_sent",
    next_action_at: iso(3),
    created_at: iso(9),
    last_inbound_at: iso(9),
    last_activity_at: iso(6),
  },
  {
    // REVIVAL: engaged once, then 30 days of silence.
    id: "lead-rick",
    customer_id: "cust-rick",
    customer_name: "Rick Ortiz",
    phone: "+15550000104",
    stage: "new",
    next_action_at: null,
    created_at: iso(40),
    last_inbound_at: iso(35),
    last_activity_at: iso(30),
  },
  {
    // THE founder's production case (fix-pass): a NEW card, 60 days old,
    // phone on file, zero conversation history — must surface as revival
    // ("no follow-up on file"), not sit invisible.
    id: "lead-cold",
    customer_id: "cust-cold",
    customer_name: "Cold Import",
    phone: "+15550000105",
    stage: "new",
    next_action_at: null,
    created_at: iso(60),
    last_inbound_at: null,
    last_activity_at: null,
  },
  {
    // Booked → terminal, never suggested.
    id: "lead-won",
    customer_id: "cust-won",
    customer_name: "Won Deal",
    phone: "+15550000106",
    stage: "booked",
    next_action_at: iso(1),
    created_at: iso(20),
    last_inbound_at: iso(20),
    last_activity_at: iso(25),
  },
]

// --- golden expectations ------------------------------------------------------

describe("golden candidate set over the seeded CRM state", () => {
  it("picks exactly the stale quote, the due follow-up, and the revival", () => {
    const stale = pickStaleQuotes(QUOTES, NOW)
    const due = pickFollowUpsDue(LEADS, NOW)
    const revival = pickRevivalLeads(LEADS, NOW)

    expect(stale.map((c) => c.ref)).toEqual(["stale_quote:q-stale"])
    expect(due.map((c) => c.ref)).toEqual([`follow_up:lead-ada:${iso(3)}`])
    expect(revival.map((c) => c.ref)).toEqual([
      "revival:lead-rick",
      "revival:lead-cold", // stale NEW lead — the fix-pass extension
    ])
  })

  it("dedupe keeps one suggestion per person, stale quote winning", () => {
    const all = dedupeCandidates([
      ...pickFollowUpsDue(LEADS, NOW), // Ada again — must lose to her quote
      ...pickStaleQuotes(QUOTES, NOW),
      ...pickRevivalLeads(LEADS, NOW),
    ])
    expect(all.map((c) => c.ref).sort()).toEqual([
      "revival:lead-cold",
      "revival:lead-rick",
      "stale_quote:q-stale",
    ])
    expect(all.find((c) => c.customerId === "cust-ada")?.kind).toBe("stale_quote")
  })
})

describe("the why cites only DB facts (grounding spot-check)", () => {
  it("stale-quote why states amount, send age, and open age from the row", () => {
    const [c] = pickStaleQuotes(QUOTES, NOW)
    expect(c.why).toBe(
      "Their $220 quote went out 6 days ago and was opened 4 days ago — no reply since."
    )
  })

  it("unopened quotes say so instead of inventing an open", () => {
    const [c] = pickStaleQuotes(
      [{ ...QUOTES[0], id: "q2", viewed_at: null, sent_at: iso(STALE_QUOTE_DAYS) }],
      NOW
    )
    expect(c.why).toContain("never opened")
  })

  it("revival why states the real silence span", () => {
    const [c] = pickRevivalLeads(LEADS, NOW)
    expect(c.why).toBe(
      "They reached out to us before, but it's been 30 days with no activity either way."
    )
  })

  it("stale-NEW why states the real card age and the missing follow-up", () => {
    const cold = pickRevivalLeads(LEADS, NOW).find((c) => c.ref === "revival:lead-cold")!
    expect(cold.why).toBe(
      "They came in as a lead 60 days ago and there's been no follow-up on file since."
    )
  })

  it("fresh NEW leads (under 14 days) are NOT picked", () => {
    const fresh = pickRevivalLeads(
      [{ ...LEADS[2], id: "lead-fresh", created_at: iso(5) }],
      NOW
    )
    expect(fresh).toEqual([])
  })
})

describe("credit discipline constants", () => {
  it("caps generation per sweep", () => {
    expect(MAX_SUGGESTIONS_PER_SWEEP).toBe(3)
  })
})
