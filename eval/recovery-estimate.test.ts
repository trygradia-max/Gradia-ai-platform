import { describe, it, expect } from "vitest"

import { estimateExtractionCredits } from "@/lib/recovery/estimate"
import { DEFAULT_PRICING, priceUsage } from "@/lib/pricing"

/**
 * Pre-run cost estimate (GRADIA_CUSTOMER_RECOVERY_SPEC acceptance: "~N credits"
 * shown before the run). The estimate must match what metering will actually
 * charge for the same number of extraction units.
 */

describe("estimateExtractionCredits", () => {
  it("is zero for an empty kept set", () => {
    expect(estimateExtractionCredits(0, DEFAULT_PRICING)).toEqual({
      units: 0,
      credits: 0,
      retailCents: 0,
    })
  })

  it("matches priceUsage for the metered SKU", () => {
    const est = estimateExtractionCredits(250, DEFAULT_PRICING)
    const priced = priceUsage(DEFAULT_PRICING, "outreach_draft", 250)
    expect(est.units).toBe(250)
    expect(est.credits).toBe(priced.credits)
    expect(est.retailCents).toBe(priced.retail_cost)
  })

  it("floors fractional/negative inputs to a sane unit count", () => {
    expect(estimateExtractionCredits(-5, DEFAULT_PRICING).units).toBe(0)
    expect(estimateExtractionCredits(3.9, DEFAULT_PRICING).units).toBe(3)
  })
})
