import { afterEach, describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { detectUsageAnomalies } from "@/lib/monitoring"

/**
 * Tier 1 — pure, no network. Locks the platform-cost early-warning heuristics:
 * spend spikes, sub-floor margin, and the global daily ceiling backstop.
 */

type Row = {
  shop_id: string
  created_at: string
  retail_cost: number | null
  wholesale_cost: number | null
}

function mockUsage(rows: Row[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        gte: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  } as unknown as SupabaseClient
}

const DAY = 86_400_000
const now = Date.now()
const todayRow = (shop: string, retail: number, wholesale = 0): Row => ({
  shop_id: shop,
  created_at: new Date(now).toISOString(),
  retail_cost: retail,
  wholesale_cost: wholesale,
})
const priorRow = (shop: string, daysAgo: number, retail: number, wholesale = 0): Row => ({
  shop_id: shop,
  created_at: new Date(now - daysAgo * DAY).toISOString(),
  retail_cost: retail,
  wholesale_cost: wholesale,
})

afterEach(() => {
  delete process.env.GLOBAL_DAILY_COST_CEILING_CENTS
})

describe("detectUsageAnomalies", () => {
  it("flags a spend spike (today ≥ 3× trailing avg, above the noise floor)", async () => {
    const rows = [
      priorRow("shop-spike", 1, 100, 10),
      priorRow("shop-spike", 2, 100, 10),
      priorRow("shop-spike", 3, 100, 10),
      todayRow("shop-spike", 800, 80), // avg prior = 100, today 800 ≥ 300 & ≥ 500
    ]
    const anomalies = await detectUsageAnomalies(mockUsage(rows))
    expect(anomalies.some((a) => a.kind === "spend_spike" && a.shopId === "shop-spike")).toBe(true)
  })

  it("flags a shop under the margin floor", async () => {
    // Single today row, no prior history → no spike; margin 30% < 50%.
    const anomalies = await detectUsageAnomalies(mockUsage([todayRow("shop-thin", 1000, 700)]))
    expect(anomalies.some((a) => a.kind === "margin_floor" && a.shopId === "shop-thin")).toBe(true)
  })

  it("stays quiet for a healthy, steady shop", async () => {
    const rows = [
      priorRow("shop-ok", 1, 300, 60),
      priorRow("shop-ok", 2, 320, 64),
      todayRow("shop-ok", 310, 62), // ~80% margin, no spike
    ]
    expect(await detectUsageAnomalies(mockUsage(rows))).toHaveLength(0)
  })

  it("raises the global ceiling alert when configured and crossed", async () => {
    process.env.GLOBAL_DAILY_COST_CEILING_CENTS = "1000"
    const rows = [todayRow("a", 600, 100), todayRow("b", 600, 100)] // $12 today ≥ $10
    const anomalies = await detectUsageAnomalies(mockUsage(rows))
    expect(anomalies.some((a) => a.kind === "global_ceiling")).toBe(true)
  })
})
