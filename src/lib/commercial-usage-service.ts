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

/**
 * Reads the immutable evidence for one explicit half-open UTC window and builds
 * the deterministic preview. Any read failure is `unavailable` — never an empty
 * result that could be rendered as zero usage or a $0 invoice.
 */
export async function readCommercialUsagePreview(
  client: SupabaseClient,
  args: { shopId: string; windowStart: string; windowEnd: string; asOf?: string }
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
    }),
  }
}
