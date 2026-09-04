import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  CREDIT_COST,
  checkAutoTopupAllowed,
  checkFeatureAccess,
  creditAllowanceThisPeriod,
  creditsFor,
  isOverCreditLimit,
  precheckCredits,
  remainingCredits,
} from "@/lib/credits"
import { PLAN } from "@/lib/pricing"

/**
 * Tier 1 — pure, deterministic, no API. Locks the allowance-based credit
 * model (GRADIA_PRICING.md, P0-013): the tier includes its credits/month
 * (Core 7,000 · Pro 6,000 · Operator 10,000; the D-035 trial 500 while a
 * trial runs); packs and rollover extend it via credit_grants; the cap IS
 * the allowance and the runtime fails closed past it.
 */

/** Table-aware mock: usage_events spend rows + credit_grants rows. */
function mockSupabase(input: {
  spent?: { credits: number }[]
  grants?: { credits: number }[]
}): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          gte: () =>
            Promise.resolve({
              data: table === "credit_grants" ? (input.grants ?? []) : (input.spent ?? []),
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

const shop = {
  id: "shop-1",
  plan: "active" as const,
  tier: "core" as const,
  trial_ends_at: null,
  credit_period_start: "2026-06-01T00:00:00Z",
}

describe("legacy credit table — historical rows only", () => {
  it("keeps the legacy kinds interpretable and prices unknown kinds at 0", () => {
    expect(creditsFor("message")).toBe(CREDIT_COST.message)
    expect(creditsFor("voice_minute")).toBe(15)
    expect(creditsFor("bi_answer")).toBe(0) // new kinds price via pricing.ts
  })
})

describe("credit allowance — included + packs + rollover", () => {
  it("an active Core plan includes 7,000 credits (D-034)", async () => {
    const allowance = await creditAllowanceThisPeriod(mockSupabase({}), shop)
    expect(allowance).toBe(PLAN.TIERS.core.includedCredits)
    expect(allowance).toBe(7000)
  })

  it("Pro and Operator include their own allowances; unknown tier reads as Core", async () => {
    expect(await creditAllowanceThisPeriod(mockSupabase({}), { ...shop, tier: "pro" })).toBe(6000)
    expect(await creditAllowanceThisPeriod(mockSupabase({}), { ...shop, tier: "operator" })).toBe(10000)
    expect(
      await creditAllowanceThisPeriod(mockSupabase({}), { ...shop, tier: "gold" as unknown as "core" })
    ).toBe(7000)
  })

  it("a running Stripe trial gets the D-035 allowance, an ended one the tier's", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    expect(
      await creditAllowanceThisPeriod(mockSupabase({}), { ...shop, tier: "pro", trial_ends_at: future })
    ).toBe(PLAN.TRIAL.credits)
    expect(
      await creditAllowanceThisPeriod(mockSupabase({}), { ...shop, tier: "pro", trial_ends_at: past })
    ).toBe(6000)
  })

  it("pack + rollover grants extend the allowance", async () => {
    const supabase = mockSupabase({
      grants: [{ credits: 950 }, { credits: 300 }],
    })
    expect(await creditAllowanceThisPeriod(supabase, shop)).toBe(8250)
  })

  it("a pre-subscription (free) shop has only its grants", async () => {
    const free = { ...shop, plan: "free" as const }
    expect(await creditAllowanceThisPeriod(mockSupabase({}), free)).toBe(0)
    expect(
      await creditAllowanceThisPeriod(
        mockSupabase({ grants: [{ credits: 950 }] }),
        free
      )
    ).toBe(950)
  })
})

describe("fail closed at the allowance", () => {
  it("under: not over, remainder = allowance - spend", async () => {
    const supabase = mockSupabase({ spent: [{ credits: 400 }, { credits: 100 }] })
    expect(await isOverCreditLimit(supabase, shop)).toBe(false)
    expect(await remainingCredits(supabase, shop)).toBe(6500)
  })

  it("at the allowance exactly: over (>= is the fail-closed edge)", async () => {
    const supabase = mockSupabase({ spent: [{ credits: 7000 }] })
    expect(await isOverCreditLimit(supabase, shop)).toBe(true)
    expect(await remainingCredits(supabase, shop)).toBe(0)
  })

  it("voice_minute rows carry credits=0 — the meters never cross", async () => {
    // A month of heavy calling (rows with credits: 0) doesn't touch credits.
    const supabase = mockSupabase({
      spent: [{ credits: 0 }, { credits: 0 }, { credits: 0 }],
    })
    expect(await remainingCredits(supabase, shop)).toBe(7000)
  })

  it("pre-check blocks before any vendor call, with the pack offer", async () => {
    const supabase = mockSupabase({ spent: [{ credits: 6950 }] })
    const check = await precheckCredits(supabase, shop, 100)
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.remaining).toBe(50)
      expect(check.reason).toContain("credit pack")
    }
  })

  it("a pack purchase un-blocks the same spend", async () => {
    const supabase = mockSupabase({
      spent: [{ credits: 6950 }],
      grants: [{ credits: 950 }],
    })
    const check = await precheckCredits(supabase, shop, 100)
    expect(check).toEqual({ ok: true, remaining: 1000 })
  })
})

describe("checkFeatureAccess — feature shutoff for Gradia Agent + Whisper", () => {
  // The hard gate every owner-initiated metered surface calls before doing
  // work. Fail-closed on both an inactive plan and an exhausted allowance.
  it("an active shop with credits left has access", async () => {
    const supabase = mockSupabase({ spent: [{ credits: 200 }] })
    expect(await checkFeatureAccess(supabase, shop)).toEqual({ ok: true })
  })

  it("shuts off when the credit allowance is used up (buy-a-pack message)", async () => {
    const supabase = mockSupabase({ spent: [{ credits: 7000 }] })
    const access = await checkFeatureAccess(supabase, shop)
    expect(access.ok).toBe(false)
    if (!access.ok) {
      expect(access.status).toBe(402)
      expect(access.reason).toContain("credit pack")
    }
  })

  it("shuts off a free (pre-subscription) shop before any spend", async () => {
    const free = { ...shop, plan: "free" as const }
    const access = await checkFeatureAccess(mockSupabase({}), free)
    expect(access.ok).toBe(false)
    if (!access.ok) expect(access.status).toBe(402)
  })

  it("shuts off a past_due shop (fail-closed, no grace)", async () => {
    const pastDue = { ...shop, plan: "past_due" as const }
    const access = await checkFeatureAccess(mockSupabase({}), pastDue)
    expect(access.ok).toBe(false)
  })
})

describe("checkAutoTopupAllowed — runaway auto-rebuy ceiling", () => {
  const base = { id: "shop-1", credit_period_start: "2026-06-01T00:00:00Z" }

  it("no ceiling set (credit_limit 0) → always allowed", async () => {
    const check = await checkAutoTopupAllowed(
      mockSupabase({ grants: [{ credits: 5000 }] }),
      { ...base, credit_limit: 0 },
      950
    )
    expect(check).toEqual({ allowed: true, ceilingRemaining: null })
  })

  it("allows an auto-top-up that stays within the monthly ceiling", async () => {
    const check = await checkAutoTopupAllowed(
      mockSupabase({ grants: [{ credits: 950 }] }),
      { ...base, credit_limit: 2000 },
      950
    )
    expect(check.allowed).toBe(true)
  })

  it("blocks an auto-top-up that would pass the ceiling (runaway agent)", async () => {
    const check = await checkAutoTopupAllowed(
      mockSupabase({ grants: [{ credits: 1900 }] }),
      { ...base, credit_limit: 2000 },
      950
    )
    expect(check.allowed).toBe(false)
    if (!check.allowed) {
      expect(check.ceilingRemaining).toBe(100)
      expect(check.reason).toContain("ceiling")
    }
  })
})
