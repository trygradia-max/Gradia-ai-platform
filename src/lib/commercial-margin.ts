export type CostRange = {
  lowCents: number
  highCents: number
}

export const COMMERCIAL_COST_ASSUMPTIONS = {
  evidenceDate: "2026-11-03",
  minimumGrossMarginBps: 6_000,
  digitalOutcomePlanningCostCents: 10,
  digitalOutcomeStopCostCents: 35,
  inboundVoiceMinute: {
    lowCents: 9.03,
    highCents: 13.74,
  },
  outboundSmsSegment: {
    lowCents: 1.18,
    highCents: 1.33,
  },
  localPhoneNumberMonthlyCents: 115,
  stripeDomesticCardPercentBps: 290,
  stripeDomesticCardFixedCents: 30,
} as const

export function grossMarginBps(revenueCents: number, costCents: number): number {
  if (!Number.isFinite(revenueCents) || revenueCents <= 0) return 0
  if (!Number.isFinite(costCents) || costCents < 0) return 0
  return Math.round(((revenueCents - costCents) / revenueCents) * 10_000)
}

export function stripeDomesticCardFeeCents(revenueCents: number): number {
  if (!Number.isFinite(revenueCents) || revenueCents <= 0) return 0
  return Math.ceil(
    (revenueCents * COMMERCIAL_COST_ASSUMPTIONS.stripeDomesticCardPercentBps) /
      10_000 +
      COMMERCIAL_COST_ASSUMPTIONS.stripeDomesticCardFixedCents
  )
}

export function unitMarginRange(
  retailUnitCents: number,
  wholesale: CostRange
): { lowBps: number; highBps: number } {
  return {
    lowBps: grossMarginBps(retailUnitCents, wholesale.highCents),
    highBps: grossMarginBps(retailUnitCents, wholesale.lowCents),
  }
}

export type PlanMarginInput = {
  monthlyRevenueCents: number
  includedVoiceMinutes: number
  includedStandardDigitalOutcomes: number
  digitalOutcomeUnitCostCents: number
}

export function estimatePlanMargin(input: PlanMarginInput) {
  const sharedCosts =
    input.includedStandardDigitalOutcomes * input.digitalOutcomeUnitCostCents +
    COMMERCIAL_COST_ASSUMPTIONS.localPhoneNumberMonthlyCents +
    stripeDomesticCardFeeCents(input.monthlyRevenueCents)
  const lowCostCents =
    sharedCosts +
    input.includedVoiceMinutes *
      COMMERCIAL_COST_ASSUMPTIONS.inboundVoiceMinute.lowCents
  const highCostCents =
    sharedCosts +
    input.includedVoiceMinutes *
      COMMERCIAL_COST_ASSUMPTIONS.inboundVoiceMinute.highCents

  return {
    lowCostCents,
    highCostCents,
    lowMarginBps: grossMarginBps(input.monthlyRevenueCents, highCostCents),
    highMarginBps: grossMarginBps(input.monthlyRevenueCents, lowCostCents),
    passesMinimumAtHighCost:
      grossMarginBps(input.monthlyRevenueCents, highCostCents) >=
      COMMERCIAL_COST_ASSUMPTIONS.minimumGrossMarginBps,
  }
}

export function maximumOutcomeCostForMinimumPlanMargin(input: Omit<
  PlanMarginInput,
  "digitalOutcomeUnitCostCents"
>): number {
  if (input.includedStandardDigitalOutcomes <= 0) return 0
  const maximumTotalCost =
    input.monthlyRevenueCents *
    (1 - COMMERCIAL_COST_ASSUMPTIONS.minimumGrossMarginBps / 10_000)
  const nonOutcomeHighCost =
    input.includedVoiceMinutes *
      COMMERCIAL_COST_ASSUMPTIONS.inboundVoiceMinute.highCents +
    COMMERCIAL_COST_ASSUMPTIONS.localPhoneNumberMonthlyCents +
    stripeDomesticCardFeeCents(input.monthlyRevenueCents)
  return Math.max(
    0,
    (maximumTotalCost - nonOutcomeHighCost) /
      input.includedStandardDigitalOutcomes
  )
}

