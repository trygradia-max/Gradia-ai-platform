import { describe, expect, it } from "vitest"

import {
  APPROVED_PLANNED_PUBLIC_TIERS,
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"
import {
  COMMERCIAL_COST_ASSUMPTIONS,
  estimatePlanMargin,
  maximumOutcomeCostForMinimumPlanMargin,
  unitMarginRange,
} from "@/lib/commercial-margin"
import { STRIPE_COMMERCIAL_PROVISIONING_MANIFEST } from "@/lib/stripe-commercial-manifest"

describe("founder-approved commercial catalog", () => {
  const plan = FOUNDER_APPROVED_COMMERCIAL_CATALOG.plans[0]

  it("locks the approved pilot, seats, cap, agents and activation terms", () => {
    expect(plan).toMatchObject({
      key: "founder-pilot",
      monthlyBaseCents: 19_900,
      includedSeats: 3,
      extraSeatCents: 3_900,
      payg: { mode: "postpaid", monthlyCapCents: 10_000 },
    })
    expect(FOUNDER_PILOT_POLICY).toMatchObject({
      includedActiveAgents: 2,
      buildAndTestDays: 14,
      billingStartTrigger: "first_agent_activation",
      maximumMonthlyOverageCapCents: 50_000,
      outcomeChargeRule: "highest_value_only",
    })
  })

  it("locks every approved overage floor", () => {
    expect(plan.payg.rates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "standard_digital_outcome",
          pricing: { kind: "fixed", retailUnitCents: 100 },
        }),
        expect.objectContaining({
          metric: "qualified_lead",
          pricing: { kind: "fixed", retailUnitCents: 500 },
        }),
        expect.objectContaining({
          metric: "confirmed_appointment",
          pricing: { kind: "fixed", retailUnitCents: 1_000 },
        }),
        expect.objectContaining({
          metric: "inbound_voice_agent_minute",
          pricing: {
            kind: "markup",
            multiplierBps: 25_000,
            minimumRetailUnitCents: 35,
          },
        }),
        expect.objectContaining({
          metric: "sms_segment",
          pricing: {
            kind: "markup",
            multiplierBps: 30_000,
            minimumRetailUnitCents: 5,
          },
        }),
      ])
    )
  })

  it("keeps public tiers out of the activatable catalog pending pilot evidence", () => {
    expect(FOUNDER_APPROVED_COMMERCIAL_CATALOG.plans).toHaveLength(1)
    expect(APPROVED_PLANNED_PUBLIC_TIERS).toHaveLength(3)
    expect(APPROVED_PLANNED_PUBLIC_TIERS.every((tier) =>
      tier.launchState === "blocked_pending_pilot_cost_evidence"
    )).toBe(true)
  })
})

describe("commercial margin guardrails", () => {
  it("shows the approved voice and SMS overages clear the 60% margin floor", () => {
    expect(
      unitMarginRange(35, COMMERCIAL_COST_ASSUMPTIONS.inboundVoiceMinute)
    ).toEqual({ lowBps: 6_074, highBps: 7_420 })
    expect(
      unitMarginRange(5, COMMERCIAL_COST_ASSUMPTIONS.outboundSmsSegment)
    ).toEqual({ lowBps: 7_340, highBps: 7_640 })
  })

  it("keeps the Founder Pilot above 60% under the digital-outcome stop cost", () => {
    expect(
      estimatePlanMargin({
        monthlyRevenueCents: 19_900,
        includedVoiceMinutes: 100,
        includedStandardDigitalOutcomes: 100,
        digitalOutcomeUnitCostCents:
          COMMERCIAL_COST_ASSUMPTIONS.digitalOutcomeStopCostCents,
      })
    ).toMatchObject({ passesMinimumAtHighCost: true })
  })

  it("reveals the outcome-cost ceilings required before public tier activation", () => {
    const ceilings = APPROVED_PLANNED_PUBLIC_TIERS.map((tier) =>
      maximumOutcomeCostForMinimumPlanMargin({
        monthlyRevenueCents: tier.monthlyBaseCents,
        includedVoiceMinutes: tier.includedVoiceMinutes,
        includedStandardDigitalOutcomes: tier.includedStandardDigitalOutcomes,
      })
    )
    expect(ceilings[0]).toBeGreaterThan(58)
    expect(ceilings[1]).toBeGreaterThan(22)
    expect(ceilings[1]).toBeLessThan(24)
    expect(ceilings[2]).toBeGreaterThan(10)
    expect(ceilings[2]).toBeLessThan(11)
  })
})

describe("Stripe provisioning manifest", () => {
  it("is deterministic and cannot activate Stripe", () => {
    expect(STRIPE_COMMERCIAL_PROVISIONING_MANIFEST).toMatchObject({
      activation: "disabled",
      product: { lookupKey: "gradia_founder_pilot_2026_11" },
      recurringPrices: [
        { unitAmountCents: 19_900 },
        { unitAmountCents: 3_900 },
      ],
      usageSettlement: {
        source: "gradia_append_only_usage_ledger",
        defaultCapCents: 10_000,
        maximumCapCents: 50_000,
      },
    })
    expect(JSON.stringify(STRIPE_COMMERCIAL_PROVISIONING_MANIFEST)).not.toContain(
      "price_"
    )
  })
})

