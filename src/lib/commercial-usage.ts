import { createHash } from "node:crypto"
import { z } from "zod"

import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"

/**
 * Commercial usage-recognition contract (Commercial Billing PR A).
 *
 * Pure and dependency-free below the Next/UI layer. Gradia's database is the
 * pricing and billing authority; nothing here talks to Stripe. The historical
 * `usage_events` provider-cost ledger is evidence only: a recognition is a
 * separate, explicit, immutable fact and is never inferred from an old row.
 */

/** Exactly the approved billable metrics. Anything else fails closed. */
export const COMMERCIAL_METRICS = [
  "standard_digital_outcome",
  "qualified_lead",
  "confirmed_appointment",
  "inbound_voice_agent_minute",
  "sms_segment",
] as const
export type CommercialMetric = (typeof COMMERCIAL_METRICS)[number]

export const OUTCOME_METRICS = [
  "standard_digital_outcome",
  "qualified_lead",
  "confirmed_appointment",
] as const
export type OutcomeMetric = (typeof OUTCOME_METRICS)[number]

export const PROVIDER_USAGE_METRICS = ["inbound_voice_agent_minute", "sms_segment"] as const
export type ProviderUsageMetric = (typeof PROVIDER_USAGE_METRICS)[number]

/** Value order for "highest-value outcome only": standard < lead < appointment. */
export const OUTCOME_RANK: Record<OutcomeMetric, number> = {
  standard_digital_outcome: 1,
  qualified_lead: 2,
  confirmed_appointment: 3,
}

export function isCommercialMetric(value: unknown): value is CommercialMetric {
  return typeof value === "string" && (COMMERCIAL_METRICS as readonly string[]).includes(value)
}
export function isOutcomeMetric(value: unknown): value is OutcomeMetric {
  return typeof value === "string" && (OUTCOME_METRICS as readonly string[]).includes(value)
}

/** The usage_events kind that is evidence for each provider metric. */
export const PROVIDER_LEDGER_KIND: Record<ProviderUsageMetric, string> = {
  inbound_voice_agent_minute: "voice_minute",
  sms_segment: "sms_segment",
}

export type OutcomeEvaluation =
  | { billable: true }
  | { billable: false; reason: string }

/**
 * Only an explicitly confirmed outcome that no human had to finish is billable.
 * Drafts, proposals, escalations, failures, unknown and anything unrecognised
 * are refused — the default is "not billable".
 */
export function evaluateOutcomeEvidence(input: {
  state: unknown
  humanCompleted: unknown
}): OutcomeEvaluation {
  if (input.humanCompleted !== false) {
    return {
      billable: false,
      reason: input.humanCompleted === true ? "human_completed" : "human_completion_unknown",
    }
  }
  if (input.state === "confirmed") return { billable: true }
  const known = ["draft", "proposal", "escalation", "failure", "unknown"]
  return {
    billable: false,
    reason: typeof input.state === "string" && known.includes(input.state) ? input.state : "unrecognised_state",
  }
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/
const decimalString = z.string().regex(DECIMAL, "decimal with at most 6 fractional digits")
const uuid = z.string().uuid()
const sourceRef = z.string().trim().min(1).max(200)
const workflowKey = z.string().trim().min(1).max(200)
const evidenceExtras = z.record(z.string(), z.unknown()).default({})

const isoUtc = z
  .string()
  .refine((value) => /(?:Z|[+-]00:?00)$/.test(value) && !Number.isNaN(Date.parse(value)), "ISO-8601 UTC time")
  .transform((value) => new Date(value).toISOString())

const wholesale = z
  .object({
    unitCostCents: decimalString,
    basis: z.enum(["provider_reported", "provider_rate_card"]),
  })
  .strict()

const outcomeRecognition = z
  .object({
    kind: z.literal("outcome"),
    shopId: uuid,
    metric: z.enum(OUTCOME_METRICS),
    workflowKey,
    sourceRef,
    outcome: z.object({ state: z.string(), humanCompleted: z.boolean() }).strict(),
    evidence: evidenceExtras,
    recognizedAt: isoUtc,
  })
  .strict()

const providerRecognition = z
  .object({
    kind: z.literal("provider_usage"),
    shopId: uuid,
    metric: z.enum(PROVIDER_USAGE_METRICS),
    usageEventId: uuid,
    sourceRef,
    quantity: decimalString,
    direction: z.enum(["inbound", "outbound"]),
    /** Absent means UNKNOWN — it is never treated as zero. */
    wholesale: wholesale.optional(),
    evidence: evidenceExtras,
    recognizedAt: isoUtc,
  })
  .strict()
  .refine((value) => value.metric !== "inbound_voice_agent_minute" || value.direction === "inbound", {
    path: ["direction"],
    message: "Only inbound voice minutes are billable",
  })

export const recognitionInputSchema = z.discriminatedUnion("kind", [
  outcomeRecognition,
  providerRecognition,
])
export type RecognitionInput = z.input<typeof recognitionInputSchema>
export type ParsedRecognitionInput = z.output<typeof recognitionInputSchema>

export const correctionInputSchema = z
  .object({
    shopId: uuid,
    recognitionId: uuid,
    quantity: decimalString,
    reason: z.enum([
      "recognized_in_error",
      "duplicate",
      "not_confirmed",
      "human_completed",
      "provider_adjustment",
    ]),
    note: z.string().max(500).optional(),
    /** Caller-owned stable reference (e.g. a review or ticket id) so a retry replays. */
    correctionRef: z.string().trim().min(1).max(120),
  })
  .strict()
export type CorrectionInput = z.input<typeof correctionInputSchema>

const digest = (parts: readonly string[]) =>
  createHash("sha256").update(parts.join("␟")).digest("hex")

/**
 * Deterministic identity of one recognized fact: the same business fact always
 * maps to the same key, regardless of retries or event order. Shop is a
 * separate column of the unique index, so it is not part of the digest.
 */
export function buildRecognitionIdempotencyKey(input: ParsedRecognitionInput): string {
  const identity =
    input.kind === "outcome" ? `workflow:${input.workflowKey}` : `ledger:${input.usageEventId}`
  return `crec.v1.${digest([APPROVED_COMMERCIAL_CATALOG_VERSION, input.metric, identity])}`
}

export function buildCorrectionIdempotencyKey(input: z.output<typeof correctionInputSchema>): string {
  return `ccor.v1.${digest([input.recognitionId, input.correctionRef])}`
}

export type RecognitionParams = Record<string, unknown>

/** Maps validated input to the exact arguments of `commercial_recognize_usage`. */
export function toRecognitionRpcParams(input: ParsedRecognitionInput): RecognitionParams {
  const base = {
    p_shop: input.shopId,
    p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
    p_metric: input.metric,
    p_recognized_at: input.recognizedAt,
    p_idempotency_key: buildRecognitionIdempotencyKey(input),
  }
  if (input.kind === "outcome") {
    return {
      ...base,
      p_quantity: 1,
      p_source_kind: "workflow_outcome",
      p_source_ref: input.sourceRef,
      p_source_usage_event_id: null,
      p_workflow_key: input.workflowKey,
      p_wholesale_unit_cost_cents: null,
      p_wholesale_basis: null,
      p_evidence: {
        ...input.evidence,
        outcome_state: input.outcome.state,
        human_completed: input.outcome.humanCompleted,
      },
    }
  }
  return {
    ...base,
    p_quantity: input.quantity,
    p_source_kind: "usage_event",
    p_source_ref: input.sourceRef,
    p_source_usage_event_id: input.usageEventId,
    p_workflow_key: null,
    p_wholesale_unit_cost_cents: input.wholesale?.unitCostCents ?? null,
    p_wholesale_basis: input.wholesale?.basis ?? null,
    p_evidence: { ...input.evidence, direction: input.direction },
  }
}

/**
 * Stripe event envelopes. Connect events (shop-to-customer invoicing on a
 * connected account) carry an `account`; Gradia platform SaaS billing is minted
 * on the platform account and has none. Connect events must never authorize a
 * write to platform commercial state, and nothing in this module consumes a
 * Stripe event at all — this guard exists so later PRs cannot forget the rule.
 */
export type StripeEnvelopeLike = { account?: unknown; livemode?: unknown; id?: unknown }

export function platformBillingScope(event: StripeEnvelopeLike | null | undefined):
  | "platform"
  | "connect"
  | "unknown" {
  if (!event || typeof event !== "object") return "unknown"
  if (event.account !== undefined && event.account !== null) return "connect"
  return typeof event.id === "string" && event.id.length > 0 ? "platform" : "unknown"
}
