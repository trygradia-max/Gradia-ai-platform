import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  CREDIT_COST,
  creditAllowanceThisPeriod,
  creditsFor,
  isOverCreditLimit,
  precheckCredits,
  remainingCredits,
} from "@/lib/credits"
import { PLAN } from "@/lib/pricing"

/**
 * Tier 1 — pure, deterministic, no API. Locks the allowance-based credit
 * model (GRADIA_PRICING.md): Core includes 1,200 credits/month; packs and
 * rollover extend it via credit_grants; the cap IS the allowance and the
 * runtime fails closed past it.
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
  it("an active Core plan includes 1,200 credits", async () => {
    const allowance = await creditAllowanceThisPeriod(mockSupabase({}), shop)
    expect(allowance).toBe(PLAN.CORE_INCLUDED_CREDITS)
    expect(allowance).toBe(1200)
  })

  it("pack + rollover grants extend the allowance", async () => {
    const supabase = mockSupabase({
      grants: [{ credits: 950 }, { credits: 300 }],
    })
    expect(await creditAllowanceThisPeriod(supabase, shop)).toBe(2450)
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
    expect(await remainingCredits(supabase, shop)).toBe(700)
  })

  it("at the allowance exactly: over (>= is the fail-closed edge)", async () => {
    const supabase = mockSupabase({ spent: [{ credits: 1200 }] })
    expect(await isOverCreditLimit(supabase, shop)).toBe(true)
    expect(await remainingCredits(supabase, shop)).toBe(0)
  })

  it("voice_minute rows carry credits=0 — the meters never cross", async () => {
    // A month of heavy calling (rows with credits: 0) doesn't touch credits.
    const supabase = mockSupabase({
      spent: [{ credits: 0 }, { credits: 0 }, { credits: 0 }],
    })
    expect(await remainingCredits(supabase, shop)).toBe(1200)
  })

  it("pre-check blocks before any vendor call, with the pack offer", async () => {
    const supabase = mockSupabase({ spent: [{ credits: 1150 }] })
    const check = await precheckCredits(supabase, shop, 100)
    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.remaining).toBe(50)
      expect(check.reason).toContain("credit pack")
    }
  })

  it("a pack purchase un-blocks the same spend", async () => {
    const supabase = mockSupabase({
      spent: [{ credits: 1150 }],
      grants: [{ credits: 950 }],
    })
    const check = await precheckCredits(supabase, shop, 100)
    expect(check).toEqual({ ok: true, remaining: 1000 })
  })
})
