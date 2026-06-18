import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { looksOptedIn, looksOptedOut } from "@/lib/agent-audience"
import { evaluateSmsSendPolicy, isQuietHours } from "@/lib/send-policy"

/**
 * Tier 1 — pure/deterministic. Locks the B2 safe-send guardrails: quiet-hours
 * windows, opt-out, and the marketing-consent (consent OR established
 * relationship) gate. All fail closed.
 */

// 2026-06-15T12:00:00Z = 8am America/New_York (EDT, UTC-4) → inside business hrs.
const NOON_UTC = Date.parse("2026-06-15T12:00:00Z")
// 2026-06-15T04:00:00Z = midnight America/New_York → quiet.
const MIDNIGHT_ET = Date.parse("2026-06-15T04:00:00Z")

describe("isQuietHours — overnight window that wraps midnight", () => {
  it("is quiet overnight and open during the day (21→8 in ET)", () => {
    expect(isQuietHours(MIDNIGHT_ET, "America/New_York", 21, 8)).toBe(true)
    expect(isQuietHours(NOON_UTC, "America/New_York", 21, 8)).toBe(false)
  })

  it("falls back gracefully on a bad timezone (never throws in a send)", () => {
    expect(() => isQuietHours(NOON_UTC, "Not/AZone", 21, 8)).not.toThrow()
  })
})

describe("opt-in / opt-out keyword detection", () => {
  it("detects STOP-family and START-family keywords, and ignores plain words", () => {
    expect(looksOptedOut("STOP")).toBe(true)
    expect(looksOptedOut("please unsubscribe me")).toBe(true)
    expect(looksOptedIn("START")).toBe(true)
    expect(looksOptedIn("subscribe please")).toBe(true)
    expect(looksOptedIn("yes I'll be there Tuesday")).toBe(false) // "yes" is not opt-in
  })
})

/** Mock returning canned rows per table; ignores filter chains. */
function mockSupabase(tables: Record<string, unknown[]>): SupabaseClient {
  function chain(table: string): unknown {
    const settle = () => ({ data: tables[table] ?? [], error: null })
    const single = () => ({ data: (tables[table] ?? [])[0] ?? null, error: null })
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (res: (v: unknown) => unknown) => Promise.resolve(settle()).then(res)
        if (prop === "maybeSingle" || prop === "single")
          return () => Promise.resolve(single())
        return () => proxy
      },
    })
    return proxy
  }
  return { from: (t: string) => chain(t) } as unknown as SupabaseClient
}

const shop = { id: "shop-1", timezone: "America/New_York", quiet_hours_start: 21, quiet_hours_end: 8 }

describe("evaluateSmsSendPolicy", () => {
  it("holds any SMS during quiet hours", async () => {
    const decision = await evaluateSmsSendPolicy(mockSupabase({}), shop, {
      toPhone: "+15551112222",
      customerId: "c1",
      category: "transactional",
      nowMs: MIDNIGHT_ET,
    })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.held).toBe(true)
  })

  it("blocks anyone who opted out, even transactional", async () => {
    const supabase = mockSupabase({
      customers: [{ id: "c1", marketing_consent_at: null, sms_opted_out_at: "2026-06-01T00:00:00Z" }],
    })
    const decision = await evaluateSmsSendPolicy(supabase, shop, {
      toPhone: "+1", customerId: "c1", category: "transactional", nowMs: NOON_UTC,
    })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain("STOP")
  })

  it("allows transactional without consent (reply/reminder/confirmation)", async () => {
    const supabase = mockSupabase({
      customers: [{ id: "c1", marketing_consent_at: null, sms_opted_out_at: null }],
    })
    const decision = await evaluateSmsSendPolicy(supabase, shop, {
      toPhone: "+1", customerId: "c1", category: "transactional", nowMs: NOON_UTC,
    })
    expect(decision.allowed).toBe(true)
  })

  it("blocks marketing with no consent and no prior contact", async () => {
    const supabase = mockSupabase({
      customers: [{ id: "c1", marketing_consent_at: null, sms_opted_out_at: null }],
      interactions: [], // no inbound → no established relationship
    })
    const decision = await evaluateSmsSendPolicy(supabase, shop, {
      toPhone: "+1", customerId: "c1", category: "marketing", nowMs: NOON_UTC,
    })
    expect(decision.allowed).toBe(false)
  })

  it("allows marketing with explicit consent", async () => {
    const supabase = mockSupabase({
      customers: [{ id: "c1", marketing_consent_at: "2026-06-10T00:00:00Z", sms_opted_out_at: null }],
      interactions: [],
    })
    const decision = await evaluateSmsSendPolicy(supabase, shop, {
      toPhone: "+1", customerId: "c1", category: "marketing", nowMs: NOON_UTC,
    })
    expect(decision.allowed).toBe(true)
  })

  it("allows marketing on an established relationship (prior inbound)", async () => {
    const supabase = mockSupabase({
      customers: [{ id: "c1", marketing_consent_at: null, sms_opted_out_at: null }],
      interactions: [{ id: "i1" }], // they messaged us before
    })
    const decision = await evaluateSmsSendPolicy(supabase, shop, {
      toPhone: "+1", customerId: "c1", category: "marketing", nowMs: NOON_UTC,
    })
    expect(decision.allowed).toBe(true)
  })
})
