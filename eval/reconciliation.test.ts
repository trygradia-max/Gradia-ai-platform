import { afterEach, describe, it, expect, vi } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  DRIFT_ALERT_THRESHOLD_PCT,
  computeDrift,
  reconcileTwilioUsage,
} from "@/lib/reconciliation"

/**
 * Tier 1 — pure, deterministic, no API. Pins the drift math the nightly
 * reconciliation alerts on (metering skill: alert at >2% drift; a vendor
 * integration isn't done until this job exists).
 */

describe("computeDrift — the 2% alert line", () => {
  it("identical totals: zero drift, no alert", () => {
    expect(computeDrift(5000, 5000)).toEqual({ driftPct: 0, alert: false })
  })

  it("exactly 2% is NOT an alert; just past it is", () => {
    expect(DRIFT_ALERT_THRESHOLD_PCT).toBe(2)
    // 9800 vs 10000 → 2.0% — at the threshold, not over it
    expect(computeDrift(9800, 10_000).alert).toBe(false)
    // 9700 vs 10000 → 3.0%
    const over = computeDrift(9700, 10_000)
    expect(over.driftPct).toBeCloseTo(3)
    expect(over.alert).toBe(true)
  })

  it("is symmetric — over-metering alerts the same as under-metering", () => {
    expect(computeDrift(10_300, 10_000).alert).toBe(true)
    expect(computeDrift(10_000, 10_300).alert).toBe(true)
  })

  it("we metered, vendor shows nothing → 100% drift, alert (above floor)", () => {
    const result = computeDrift(500, 0)
    expect(result.driftPct).toBe(100)
    expect(result.alert).toBe(true)
  })

  it("noise floor: huge relative drift on tiny totals stays quiet", () => {
    // 2¢ vs 4¢ is 50% drift but rounding territory, not a metering gap
    expect(computeDrift(2, 4).alert).toBe(false)
    // both zero is simply clean
    expect(computeDrift(0, 0)).toEqual({ driftPct: 0, alert: false })
  })
})

describe("reconcileTwilioUsage — failures are skipped, never silent zeros", () => {
  afterEach(() => vi.unstubAllGlobals())

  function mockSupabase(shops: unknown[], ledgerRows: { wholesale_cost: number }[]) {
    return {
      from: (table: string) => {
        if (table === "shops") {
          return {
            select: () => ({
              not: () => Promise.resolve({ data: shops, error: null }),
            }),
          }
        }
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                gte: () => Promise.resolve({ data: ledgerRows, error: null }),
              }),
            }),
          }),
        }
      },
    } as unknown as SupabaseClient
  }

  it("a shop whose vendor fetch fails counts as skipped, not as zero drift", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("twilio down")
      })
    )
    // Subaccount token won't decrypt (garbage) for shop A → skipped before
    // any vendor call; shop B has no sid → also skipped.
    const summary = await reconcileTwilioUsage(
      mockSupabase(
        [
          {
            id: "shop-a",
            name: "A",
            twilio_subaccount_sid: "ACsub",
            twilio_subaccount_token_enc: "not-decryptable",
          },
          {
            id: "shop-b",
            name: "B",
            twilio_subaccount_sid: null,
            twilio_subaccount_token_enc: null,
          },
        ],
        [{ wholesale_cost: 500 }]
      )
    )
    expect(summary.checked).toBe(0)
    expect(summary.skipped).toBe(2)
    expect(summary.drifting).toEqual([])
  })
})
