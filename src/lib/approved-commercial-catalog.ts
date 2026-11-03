import {
  type CommercialCatalog,
  validateCommercialCatalog,
} from "@/lib/commercial-pricing"

export const APPROVED_COMMERCIAL_CATALOG_VERSION = "2026-11-03.v1"

const founderPilotInput = {
  currency: "usd",
  plans: [
    {
      key: "founder-pilot",
      label: "Founder Pilot",
      monthlyBaseCents: 19_900,
      includedSeats: 3,
      extraSeatCents: 3_900,
      payg: {
        mode: "postpaid",
        monthlyCapCents: 10_000,
        rates: [
          {
            metric: "standard_digital_outcome",
            unitLabel: "standard completed digital outcome",
            includedQuantity: 100,
            pricing: { kind: "fixed", retailUnitCents: 100 },
          },
          {
            metric: "qualified_lead",
            unitLabel: "qualified lead handed to a human",
            includedQuantity: 0,
            pricing: { kind: "fixed", retailUnitCents: 500 },
          },
          {
            metric: "confirmed_appointment",
            unitLabel: "confirmed appointment attributable to Gradia",
            includedQuantity: 0,
            pricing: { kind: "fixed", retailUnitCents: 1_000 },
          },
          {
            metric: "inbound_voice_agent_minute",
            unitLabel: "inbound voice-agent minute",
            includedQuantity: 100,
            pricing: {
              kind: "markup",
              multiplierBps: 25_000,
              minimumRetailUnitCents: 35,
            },
          },
          {
            metric: "sms_segment",
            unitLabel: "SMS segment",
            includedQuantity: 0,
            pricing: {
              kind: "markup",
              multiplierBps: 30_000,
              minimumRetailUnitCents: 5,
            },
          },
        ],
      },
    },
  ],
} as const

const parsedFounderPilot = validateCommercialCatalog(founderPilotInput)
if (!parsedFounderPilot.ok) {
  throw new Error(
    `Founder-approved commercial catalog is invalid: ${parsedFounderPilot.issues.join("; ")}`
  )
}

/**
 * Founder-approved terms. This is application configuration, not a Stripe object
 * and not authority to collect money or enable production checkout.
 */
export const FOUNDER_APPROVED_COMMERCIAL_CATALOG: CommercialCatalog =
  parsedFounderPilot.catalog

export const FOUNDER_PILOT_POLICY = {
  planKey: "founder-pilot",
  launchState: "approved_not_activated",
  approvedAt: "2026-11-03",
  includedActiveAgents: 2,
  billableRoles: ["owner", "manager", "staff"],
  excludedSeatStates: ["read_only", "pending_invitation", "inactive", "revoked"],
  extraSeatProration: "daily",
  buildAndTestDays: 14,
  billingStartTrigger: "first_agent_activation",
  cardRequiredTrigger: "agent_activation",
  defaultMonthlyOverageCapCents: 10_000,
  maximumMonthlyOverageCapCents: 50_000,
  includedUsageRollover: false,
  grandfatheredMonths: 12,
  outcomeChargeRule: "highest_value_only",
  currency: "usd",
} as const

/**
 * Approved product direction, intentionally excluded from the active catalog.
 * These plans need measured pilot cost evidence before Stripe provisioning.
 */
export const APPROVED_PLANNED_PUBLIC_TIERS = [
  {
    key: "core",
    label: "Core",
    monthlyBaseCents: 19_900,
    includedSeats: 3,
    includedActiveAgents: 2,
    includedStandardDigitalOutcomes: 100,
    includedVoiceMinutes: 100,
    launchState: "blocked_pending_pilot_cost_evidence",
  },
  {
    key: "growth",
    label: "Growth",
    monthlyBaseCents: 49_900,
    includedSeats: 8,
    includedActiveAgents: 6,
    includedStandardDigitalOutcomes: 500,
    includedVoiceMinutes: 500,
    launchState: "blocked_pending_pilot_cost_evidence",
  },
  {
    key: "scale",
    label: "Scale",
    monthlyBaseCents: 99_900,
    includedSeats: 20,
    includedActiveAgents: 15,
    includedStandardDigitalOutcomes: 1_500,
    includedVoiceMinutes: 1_500,
    launchState: "blocked_pending_pilot_cost_evidence",
  },
] as const

