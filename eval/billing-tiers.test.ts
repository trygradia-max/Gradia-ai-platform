import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { PLAN, TIER_ORDER, tierSpec } from "@/lib/pricing"

/**
 * P0-013 — production billing model alignment (D-031 three-tier).
 *
 * 1. Source-scan: no component may hardcode a legacy plan price. The
 *    retired two-SKU model was $20 (Core), $29 (voice add-on) and $49
 *    (bundled) with $10 packs advertised inline. Every one of those must
 *    now be DERIVED from PLAN.TIERS / PLAN.CREDIT_PACK / PLAN.MINUTE_PACK
 *    via formatUsd — this test greps the components that used to hardcode
 *    them and fails if a legacy literal reappears.
 * 2. Tier lineup lock: the approved numbers (D-031 prices, D-034 contents)
 *    read from the one module nothing else may hardcode.
 */

const OWNER_VISIBLE_FILES = [
  "src/app/billing/page.tsx",
  "src/components/gradia/billing-subscribe.tsx",
  "src/components/gradia/usage-meters.tsx",
  "src/components/gradia/usage-pill.tsx",
  "src/components/gradia/onboarding-launch-steps.tsx",
  "src/app/how-it-works/page.tsx",
  "src/app/actions/voice-builder.ts",
]

// Legacy plan-price literals from the retired $20 Core + $29 voice add-on
// model (C-14) — a dollar amount immediately followed by "/mo" or "/month",
// or a bare "$20"/"$29"/"$49" plan-price mention. Deliberately narrow so it
// doesn't flag unrelated dollar amounts (e.g. a customer invoice example).
const LEGACY_PLAN_PRICE = /\$(20|29|49)(\.00)?\s*\/\s*mo(nth)?\b/i

describe("source-scan — no legacy plan-price literal survives P0-013", () => {
  for (const file of OWNER_VISIBLE_FILES) {
    it(`${file} derives every plan price from lib/pricing.ts`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8")
      const match = source.match(LEGACY_PLAN_PRICE)
      expect(match, `found legacy price literal ${match?.[0]} in ${file}`).toBeNull()
    })
  }
})

describe("tier lineup — locked to the approved numbers (D-031 / D-034)", () => {
  it("cheapest → dearest order matches the public lineup", () => {
    expect(TIER_ORDER).toEqual(["core", "pro", "operator"])
  })

  it("Core: $99, 7,000 credits, no voice, suggest-first only", () => {
    expect(tierSpec("core")).toMatchObject({
      priceCents: 9900,
      includedCredits: 7000,
      includedMinutes: 0,
      voice: false,
      autonomy: false,
      teamSeats: false,
      prioritySupport: false,
    })
  })

  it("Pro: $149, 6,000 credits + 100 minutes, voice + earned autonomy", () => {
    expect(tierSpec("pro")).toMatchObject({
      priceCents: 14900,
      includedCredits: 6000,
      includedMinutes: 100,
      voice: true,
      autonomy: true,
      teamSeats: false,
      prioritySupport: false,
    })
  })

  it("Operator: $249, 10,000 credits + 180 minutes, team seats + priority support", () => {
    expect(tierSpec("operator")).toMatchObject({
      priceCents: 24900,
      includedCredits: 10000,
      includedMinutes: 180,
      voice: true,
      autonomy: true,
      teamSeats: true,
      prioritySupport: true,
    })
  })

  it("an unrecognized tier value reads as Core — fail closed, never a guessed upgrade", () => {
    expect(tierSpec("enterprise" as never)).toEqual(tierSpec("core"))
    expect(tierSpec(null)).toEqual(tierSpec("core"))
    expect(tierSpec(undefined)).toEqual(tierSpec("core"))
  })

  it("packs and rollover are unchanged from the legacy model (D-034 — carried forward)", () => {
    expect(PLAN.CREDIT_PACK).toEqual({ credits: 950, priceCents: 1000 })
    expect(PLAN.MINUTE_PACK).toEqual({ minutes: 40, priceCents: 1000 })
    expect(PLAN.ROLLOVER_MAX_FRACTION).toBe(0.25)
  })

  it("trial: 14 days, 500 credits + 15 minutes (D-035 interim)", () => {
    expect(PLAN.TRIAL).toEqual({ days: 14, credits: 500, minutes: 15 })
  })
})
