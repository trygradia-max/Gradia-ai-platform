import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { precheckCredits } from "@/lib/credits"
import {
  DEFAULT_PRICING,
  getPricing,
  humanUnits,
  marginCents,
  PLAN,
  priceUsage,
  rolloverCredits,
  smsSegments,
  type Pricing,
} from "@/lib/pricing"

/**
 * Tier 1 — pure, deterministic, no API. Locks the white-label markup math
 * (telephony spec §1.4) and the pre-check-before-vendor-call ordering the
 * gradia-metering-billing conventions require.
 */

/** Fixture pricing distinct from defaults — proves nothing is hardcoded. */
const FIXTURE: Pricing = {
  number_monthly: { wholesale_cents: 100, retail_cents: 300 },
  voice_minute: { wholesale_cents: 10, retail_cents: 25 },
  sms_segment: { wholesale_cents: 0.5, retail_cents: 3 },
  email_send: { wholesale_cents: 0.2, retail_cents: 2 },
  outreach_draft: { wholesale_cents: 0.2, retail_cents: 2 },
  bi_answer: { wholesale_cents: 1, retail_cents: 5 },
  whisper_note: { wholesale_cents: 1, retail_cents: 2 },
  agentic_plan: { wholesale_cents: 2, retail_cents: 8 },
  // Cost-visibility SKU (2026-07-13): retail 0 by design — callers pass
  // credits: 0 explicitly; priceUsage's never-free floor doesn't apply.
  inbound_classify: { wholesale_cents: 0.3, retail_cents: 0 },
}

function mockPricingTable(result: {
  data: unknown[] | null
  error: { message: string } | null
}): SupabaseClient {
  return {
    from: () => ({ select: () => Promise.resolve(result) }),
  } as unknown as SupabaseClient
}

function mockLedger(spentRows: { credits: number }[]): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          gte: () =>
            Promise.resolve({
              // usage spend rows; no grants — allowance is plan-included only
              data: table === "credit_grants" ? [] : spentRows,
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe("markup math — config-driven, never hardcoded", () => {
  it("prices from whatever config it's given (fixture, not defaults)", () => {
    const number = priceUsage(FIXTURE, "number_monthly")
    expect(number).toEqual({
      wholesale_cost: 100,
      retail_cost: 300,
      credits: 300,
    })
    expect(marginCents(number)).toBe(200)

    const minutes = priceUsage(FIXTURE, "voice_minute", 12)
    expect(minutes.wholesale_cost).toBe(120)
    expect(minutes.retail_cost).toBe(300)
    expect(marginCents(minutes)).toBe(180)
  })

  it("handles sub-cent wholesale without losing margin precision", () => {
    const seg = priceUsage(FIXTURE, "sms_segment", 3)
    expect(seg.wholesale_cost).toBeCloseTo(1.5)
    expect(seg.retail_cost).toBe(9)
    expect(marginCents(seg)).toBeCloseTo(7.5)
  })

  it("credits round UP so a fractional-cent action is never free", () => {
    const tiny = priceUsage(
      { ...FIXTURE, sms_segment: { wholesale_cents: 0.3, retail_cents: 0.4 } },
      "sms_segment",
      1
    )
    expect(tiny.credits).toBe(1)
  })

  it("zero quantity costs zero; negative quantity clamps (corrections are compensating entries, not negatives)", () => {
    expect(priceUsage(FIXTURE, "voice_minute", 0).credits).toBe(0)
    expect(priceUsage(FIXTURE, "voice_minute", -5).retail_cost).toBe(0)
  })
})

describe("pricing config load — DB rows win, failure falls back safely", () => {
  it("merges table rows over defaults", async () => {
    const supabase = mockPricingTable({
      data: [{ key: "number_monthly", wholesale_cents: 115, retail_cents: 500 }],
      error: null,
    })
    const pricing = await getPricing(supabase)
    expect(pricing.number_monthly.retail_cents).toBe(500)
    // untouched keys keep documented defaults
    expect(pricing.sms_segment).toEqual(DEFAULT_PRICING.sms_segment)
  })

  it("a config read error falls back to defaults — a metered action is never free", async () => {
    const supabase = mockPricingTable({
      data: null,
      error: { message: "db unreachable" },
    })
    expect(await getPricing(supabase)).toEqual(DEFAULT_PRICING)
  })

  it("ignores unknown keys instead of widening the pricing surface", async () => {
    const supabase = mockPricingTable({
      data: [{ key: "free_lunch", wholesale_cents: 0, retail_cents: 0 }],
      error: null,
    })
    expect(await getPricing(supabase)).toEqual(DEFAULT_PRICING)
  })
})

describe("pre-check before vendor call — the allowance prevents the spend", () => {
  const shop = {
    id: "shop-1",
    plan: "active" as const, // 1,200 included
    credit_period_start: "2026-06-01T00:00:00Z",
  }

  it("blocks when the priced cost exceeds remaining credits", async () => {
    const supabase = mockLedger([{ credits: 1100 }])
    const cost = priceUsage(FIXTURE, "number_monthly").credits // 300
    const check = await precheckCredits(supabase, shop, cost)
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.remaining).toBe(100)
      expect(check.reason).toContain("credit pack")
    }
  })

  it("allows when the cost fits, reporting what remains", async () => {
    const supabase = mockLedger([{ credits: 300 }])
    const check = await precheckCredits(supabase, shop, 300)
    expect(check).toEqual({ ok: true, remaining: 900 })
  })

  it("a free (pre-subscription) shop has zero allowance — explore, can't send", async () => {
    const supabase = mockLedger([])
    const check = await precheckCredits(
      supabase,
      { ...shop, plan: "free" as const },
      1
    )
    expect(check.ok).toBe(false)
  })
})

describe("plan structure helpers", () => {
  it("smsSegments: 160 chars = 1; multipart at 153 each", () => {
    expect(smsSegments("a".repeat(160))).toBe(1)
    expect(smsSegments("a".repeat(161))).toBe(2)
    expect(smsSegments("a".repeat(306))).toBe(2)
    expect(smsSegments("a".repeat(307))).toBe(3)
    expect(smsSegments("")).toBe(1)
  })

  it("humanUnits frames credits as texts/emails and minutes as calls", () => {
    const h = humanUnits({ creditsRemaining: 1200, minutesRemaining: 60 })
    expect(h.texts).toBe(300) // 1200 / 4-credit segments
    expect(h.emails).toBe(1200)
    expect(h.calls).toBe(20) // 60 min ≈ 20 answered calls
    expect(humanUnits({ creditsRemaining: 100 }).calls).toBeNull()
  })

  it("rollover: up to 25% of unused INCLUDED credits, never more", () => {
    // barely used → capped at 25% of 1200 = 300
    expect(rolloverCredits({ includedCredits: 1200, spentCredits: 100 })).toBe(300)
    // mostly used → whatever's left
    expect(rolloverCredits({ includedCredits: 1200, spentCredits: 1100 })).toBe(100)
    // fully used / overspent → nothing rolls
    expect(rolloverCredits({ includedCredits: 1200, spentCredits: 1200 })).toBe(0)
    expect(rolloverCredits({ includedCredits: 1200, spentCredits: 5000 })).toBe(0)
  })

  it("locked SKU numbers match the pricing doc", () => {
    expect(PLAN.CORE_INCLUDED_CREDITS).toBe(1200)
    expect(PLAN.VOICE_INCLUDED_MINUTES).toBe(60)
    expect(PLAN.CREDIT_PACK).toEqual({ credits: 950, priceCents: 1000 })
    expect(PLAN.MINUTE_PACK).toEqual({ minutes: 40, priceCents: 1000 })
    expect(DEFAULT_PRICING.sms_segment.retail_cents).toBe(4)
    expect(DEFAULT_PRICING.bi_answer.retail_cents).toBe(7)
    expect(DEFAULT_PRICING.agentic_plan.retail_cents).toBe(10)
  })
})
