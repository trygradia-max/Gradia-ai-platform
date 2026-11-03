import {
  APPROVED_COMMERCIAL_CATALOG_VERSION,
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"

const founderPilot = FOUNDER_APPROVED_COMMERCIAL_CATALOG.plans.find(
  (plan) => plan.key === FOUNDER_PILOT_POLICY.planKey
)
if (!founderPilot) throw new Error("Founder Pilot plan is missing")

/**
 * Deterministic input for a future reviewed Stripe provisioning command.
 * It contains no Stripe IDs, makes no network call, and cannot enable checkout.
 */
export const STRIPE_COMMERCIAL_PROVISIONING_MANIFEST = {
  manifestVersion: APPROVED_COMMERCIAL_CATALOG_VERSION,
  activation: "disabled",
  currency: "usd",
  product: {
    lookupKey: "gradia_founder_pilot_2026_11",
    name: "Gradia Founder Pilot",
    metadata: {
      catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
      plan_key: founderPilot.key,
    },
  },
  recurringPrices: [
    {
      lookupKey: "gradia_founder_pilot_2026_11_monthly",
      unitAmountCents: founderPilot.monthlyBaseCents,
      interval: "month",
      kind: "workspace_subscription",
    },
    {
      lookupKey: "gradia_operator_seat_2026_11_monthly",
      unitAmountCents: founderPilot.extraSeatCents,
      interval: "month",
      kind: "additional_operator_seat",
      proration: FOUNDER_PILOT_POLICY.extraSeatProration,
    },
  ],
  usageSettlement: {
    source: "gradia_append_only_usage_ledger",
    rates: founderPilot.payg.rates,
    defaultCapCents: FOUNDER_PILOT_POLICY.defaultMonthlyOverageCapCents,
    maximumCapCents: FOUNDER_PILOT_POLICY.maximumMonthlyOverageCapCents,
    outcomeChargeRule: FOUNDER_PILOT_POLICY.outcomeChargeRule,
  },
  trial: {
    days: FOUNDER_PILOT_POLICY.buildAndTestDays,
    billingStarts: FOUNDER_PILOT_POLICY.billingStartTrigger,
    cardRequired: FOUNDER_PILOT_POLICY.cardRequiredTrigger,
  },
} as const

