/**
 * Pre-run cost estimate for a Customer Recovery import (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC acceptance: "This import will use ~N credits"
 * shown to the owner BEFORE the run). Pure — the caller loads pricing via
 * getPricing and passes it in.
 *
 * Extraction is a single-turn Haiku structured call per kept thread/contact, so
 * we price it against the existing `outreach_draft` SKU (same cost class). A
 * dedicated `recovery_extract` SKU is a later refinement; reusing an existing
 * key avoids destabilizing the pricing locking tests for now.
 */

import { priceUsage, type Pricing } from "@/lib/pricing"

/** The SKU extraction is metered/estimated against. */
export const EXTRACTION_SKU = "outreach_draft" as const

export type ExtractionEstimate = {
  /** Threads/contacts that survived the pre-filter and will hit the LLM. */
  units: number
  /** Credits the run will consume (what the owner sees before approving). */
  credits: number
  /** Retail cost in cents, for display. */
  retailCents: number
}

export function estimateExtractionCredits(
  keptUnits: number,
  pricing: Pricing
): ExtractionEstimate {
  const units = Math.max(0, Math.floor(keptUnits))
  if (units === 0) {
    return { units: 0, credits: 0, retailCents: 0 }
  }
  const priced = priceUsage(pricing, EXTRACTION_SKU, units)
  return {
    units,
    credits: priced.credits,
    retailCents: priced.retail_cost,
  }
}
