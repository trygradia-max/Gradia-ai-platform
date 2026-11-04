import { createHash } from "node:crypto"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"
import {
  buildCorrectionIdempotencyKey,
  correctionInputSchema,
  evaluateOutcomeEvidence,
  recognitionInputSchema,
  toRecognitionRpcParams,
  type CorrectionInput,
  type RecognitionInput,
} from "@/lib/commercial-usage"
import type {
  MembershipEvidence,
  MembershipEvidenceUnavailable,
} from "@/lib/commercial-seat-proration"
import {
  previewCommercialPeriod,
  type CommercialPeriodPreview,
} from "@/lib/commercial-usage-preview"

/**
 * Server-side wrappers over the commercial usage RPC boundary.
 *
 * Writers (`recognize`, `correct`) require a SERVICE-ROLE client and must be
 * given a shop the server derived from its own evidence — never a client
 * selected one. The database refuses any other caller. The reader works with an
 * owner session: the database re-derives live owner membership on every call.
 */

export type CommercialWriteFailure =
  | "invalid"
  | "not_billable"
  | "conflict"
  | "forbidden"
  | "failed"

export type CommercialWriteResult =
  | { ok: true; id: string; replayed: boolean }
  | { ok: false; reason: CommercialWriteFailure; detail?: string }

const rpcResult = z.object({ id: z.string().uuid(), replayed: z.boolean() })

function classify(error: { code?: string; message?: string }): CommercialWriteResult {
  switch (error.code) {
    case "CB409":
      return { ok: false, reason: "conflict" }
    case "CB422":
      return { ok: false, reason: "not_billable" }
    case "42501":
      return { ok: false, reason: "forbidden" }
    case "22023":
      return { ok: false, reason: "invalid" }
    default:
      // Transport/database failure: the fact is NOT durably present.
      return { ok: false, reason: "failed" }
  }
}

export async function recognizeCommercialUsage(
  serviceClient: SupabaseClient,
  input: RecognitionInput
): Promise<CommercialWriteResult> {
  const parsed = recognitionInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, reason: "invalid", detail: parsed.error.issues[0]?.message }
  }
  if (parsed.data.kind === "outcome") {
    const evaluation = evaluateOutcomeEvidence({
      state: parsed.data.outcome.state,
      humanCompleted: parsed.data.outcome.humanCompleted,
    })
    if (!evaluation.billable) return { ok: false, reason: "not_billable", detail: evaluation.reason }
  }
  const { data, error } = await serviceClient.rpc("commercial_recognize_usage", toRecognitionRpcParams(parsed.data))
  if (error) return classify(error)
  const result = rpcResult.safeParse(data)
  return result.success
    ? { ok: true, id: result.data.id, replayed: result.data.replayed }
    : { ok: false, reason: "failed" }
}

export async function correctCommercialUsage(
  serviceClient: SupabaseClient,
  input: CorrectionInput
): Promise<CommercialWriteResult> {
  const parsed = correctionInputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, reason: "invalid", detail: parsed.error.issues[0]?.message }
  }
  const { data, error } = await serviceClient.rpc("commercial_correct_usage", {
    p_shop: parsed.data.shopId,
    p_recognition_id: parsed.data.recognitionId,
    p_quantity: parsed.data.quantity,
    p_reason: parsed.data.reason,
    p_note: parsed.data.note ?? null,
    p_idempotency_key: buildCorrectionIdempotencyKey(parsed.data),
  })
  if (error) return classify(error)
  const result = rpcResult.safeParse(data)
  return result.success
    ? { ok: true, id: result.data.id, replayed: result.data.replayed }
    : { ok: false, reason: "failed" }
}

const factRow = z.object({
  id: z.string(),
  catalog_version: z.string(),
  metric: z.string(),
  quantity: z.string(),
  workflow_key: z.string().nullable(),
  wholesale_unit_cost_cents: z.string().nullable(),
  wholesale_basis: z.string().nullable(),
  recognized_at: z.string(),
  recorded_at: z.string(),
})
const correctionRow = z.object({
  id: z.string(),
  recognition_id: z.string(),
  quantity: z.string(),
  reason: z.string(),
  recorded_at: z.string(),
})
const readDto = z.object({
  facts: z.array(factRow),
  corrections: z.array(correctionRow),
  prior_workflow_metrics: z.record(z.string(), z.string()),
  as_of: z.string(),
})

export type CommercialPreviewRead =
  | { status: "forbidden" }
  | { status: "unavailable"; reason: "invalid_window" | "read_failed" | "malformed_evidence" }
  | { status: "ready"; preview: CommercialPeriodPreview }

const membershipEventRow = z.object({
  id: z.string(),
  shop_seq: z.number().int(),
  user_id: z.string(),
  kind: z.string(),
  new_billable: z.boolean(),
  effective_at: z.string(),
  recorded_at: z.string(),
})
const membershipDto = z.object({
  coverage: z
    .object({ covered_from: z.string(), basis: z.string(), recorded_at: z.string() })
    .nullable(),
  events: z.array(membershipEventRow),
})

async function readMembershipEvidence(
  client: SupabaseClient,
  args: { shopId: string; windowStart: string; windowEnd: string; asOf: string }
): Promise<MembershipEvidence | MembershipEvidenceUnavailable | "forbidden"> {
  const { data, error } = await client.rpc("commercial_membership_read", {
    p_shop: args.shopId,
    p_window_start: args.windowStart,
    p_window_end: args.windowEnd,
    p_as_of: args.asOf,
  })
  if (error) {
    return error.code === "42501" ? "forbidden" : { status: "unavailable", code: "membership_read_failed" }
  }
  const dto = membershipDto.safeParse(data)
  if (!dto.success) return { status: "unavailable", code: "malformed_membership_evidence" }
  return {
    status: "evidence",
    coverage: dto.data.coverage
      ? {
          coveredFrom: dto.data.coverage.covered_from,
          basis: dto.data.coverage.basis,
          recordedAt: dto.data.coverage.recorded_at,
        }
      : null,
    events: dto.data.events.map((event) => ({
      id: event.id,
      shopSeq: event.shop_seq,
      userId: event.user_id,
      kind: event.kind,
      newBillable: event.new_billable,
      effectiveAt: event.effective_at,
      recordedAt: event.recorded_at,
    })),
  }
}

async function readPreview(
  client: SupabaseClient,
  args: { shopId: string; windowStart: string; windowEnd: string; asOf?: string },
  withMembership: boolean
): Promise<CommercialPreviewRead> {
  // A window must be an explicit UTC instant pair; never rely on a server timezone.
  const utc = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]00:?00)$/
  if (![args.windowStart, args.windowEnd].every((value) => utc.test(value) && !Number.isNaN(Date.parse(value)))) {
    return { status: "unavailable", reason: "invalid_window" }
  }
  const { data, error } = await client.rpc("commercial_usage_read", {
    p_shop: args.shopId,
    p_window_start: args.windowStart,
    p_window_end: args.windowEnd,
    p_as_of: args.asOf ?? null,
  })
  if (error) {
    return error.code === "42501" ? { status: "forbidden" } : { status: "unavailable", reason: "read_failed" }
  }
  const dto = readDto.safeParse(data)
  if (!dto.success) return { status: "unavailable", reason: "malformed_evidence" }

  // Membership evidence is read at the SAME as-of instant so both halves describe one moment.
  let membership: MembershipEvidence | MembershipEvidenceUnavailable | undefined
  if (withMembership) {
    const evidence = await readMembershipEvidence(client, { ...args, asOf: dto.data.as_of })
    if (evidence === "forbidden") return { status: "forbidden" }
    membership = evidence
  }

  return {
    status: "ready",
    preview: previewCommercialPeriod({
      catalog: FOUNDER_APPROVED_COMMERCIAL_CATALOG,
      planKey: FOUNDER_PILOT_POLICY.planKey,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      asOf: dto.data.as_of,
      facts: dto.data.facts.map((fact) => ({
        id: fact.id,
        catalogVersion: fact.catalog_version,
        metric: fact.metric,
        quantity: fact.quantity,
        workflowKey: fact.workflow_key,
        wholesaleUnitCostCents: fact.wholesale_unit_cost_cents,
        wholesaleBasis: fact.wholesale_basis,
        recognizedAt: fact.recognized_at,
        recordedAt: fact.recorded_at,
      })),
      corrections: dto.data.corrections.map((correction) => ({
        id: correction.id,
        recognitionId: correction.recognition_id,
        quantity: correction.quantity,
        reason: correction.reason,
        recordedAt: correction.recorded_at,
      })),
      priorWorkflowMetrics: dto.data.prior_workflow_metrics,
      ...(membership ? { membership } : {}),
    }),
  }
}

/**
 * Usage-only preview (Commercial Billing PR A behavior, unchanged). Seat proration
 * stays `seat_proration_unavailable` because no membership evidence is requested.
 * Any read failure is `unavailable` — never an empty result that could be rendered
 * as zero usage or a $0 invoice.
 */
export function readCommercialUsagePreview(
  client: SupabaseClient,
  args: { shopId: string; windowStart: string; windowEnd: string; asOf?: string }
): Promise<CommercialPreviewRead> {
  return readPreview(client, args, false)
}

/**
 * Full period preview: usage plus deterministic daily extra-seat proration from
 * immutable membership billing history. A membership read failure leaves seat
 * proration unavailable (never zero) and does not affect usage.
 */
export function readCommercialPeriodPreview(
  client: SupabaseClient,
  args: { shopId: string; windowStart: string; windowEnd: string; asOf?: string }
): Promise<CommercialPreviewRead> {
  return readPreview(client, args, true)
}

type MembershipCorrectionResult = CommercialWriteResult

/** Service-role only. Appends an explicit compensating billing fact; never edits history. */
export async function correctMembershipBilling(
  serviceClient: SupabaseClient,
  input: {
    shopId: string
    userId: string
    effectiveAt: string
    billable: boolean
    correctsEventId: string
    reason: string
    /** Caller-owned stable reference so a retry replays instead of duplicating. */
    correctionRef: string
  }
): Promise<MembershipCorrectionResult> {
  const uuid = z.string().uuid()
  const parsed = z
    .object({
      shopId: uuid,
      userId: uuid,
      effectiveAt: z.string().refine((v) => /(?:Z|[+-]00:?00)$/.test(v) && !Number.isNaN(Date.parse(v))),
      billable: z.boolean(),
      correctsEventId: uuid,
      reason: z.string().trim().min(1).max(500),
      correctionRef: z.string().trim().min(1).max(120),
    })
    .strict()
    .safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", detail: parsed.error.issues[0]?.message }
  const { data, error } = await serviceClient.rpc("commercial_membership_correct", {
    p_shop: parsed.data.shopId,
    p_user_id: parsed.data.userId,
    // Passed through unchanged: a JS Date would truncate microseconds, and an event's recorded
    // instant is microsecond-exact. The database parses and range-checks it.
    p_effective_at: parsed.data.effectiveAt,
    p_billable: parsed.data.billable,
    p_corrects_event_id: parsed.data.correctsEventId,
    p_reason: parsed.data.reason,
    p_idempotency_key: `mcor.v1.${createHash("sha256")
      .update([parsed.data.shopId, parsed.data.userId, parsed.data.correctionRef].join("\u241f"))
      .digest("hex")}`,
  })
  if (error) return classify(error)
  const result = rpcResult.safeParse(data)
  return result.success
    ? { ok: true, id: result.data.id, replayed: result.data.replayed }
    : { ok: false, reason: "failed" }
}
