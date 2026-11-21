import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { redactTranscriptText, type RedactionKind } from "./redaction"

/**
 * Consented transcript evidence (PR E): ingest, seal and gated read.
 *
 * Transcript text reaches the database through exactly one door, `call_copilot_record_segment`, which
 * runs the merged PR D capture gate for the segment's EXACT captured time and requires the whole span
 * to lie inside one consented interval BEFORE anything is stored. Declined, missing, mismatched,
 * paused-gap, stopped, unknown or conflicting consent therefore stores nothing. The shop id is an
 * explicit server-resolved argument, never read from the segment, and no role can read the table.
 *
 * Replay: an exact repeat of a segment is `duplicate`; the same segment id or index with DIFFERENT
 * text is a `conflict`, recorded, and it fails the whole call closed for every derived use.
 */

export class TranscriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TranscriptError"
  }
}

const uuid = z.string().uuid()

export const transcriptSegmentSchema = z
  .object({
    providerSegmentId: z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/),
    index: z.number().int().min(0).max(4999),
    speaker: z.enum(["operator", "caller", "unknown"]),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
    text: z.string().min(1).max(2000),
  })
  .strict()
export type TranscriptSegmentInput = z.infer<typeof transcriptSegmentSchema>

export type SegmentOutcome =
  | { outcome: "recorded"; segmentId: string; redactions: RedactionKind[] }
  | { outcome: "duplicate"; segmentId: string }
  | { outcome: "conflict"; conflictKind: "segment_id_changed" | "index_reused" }
  | { outcome: "denied"; reason: string }
  | { outcome: "invalid" }

const segmentResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("recorded"), segment_id: z.string().uuid(), digest: z.string() }),
  z.object({ outcome: z.literal("duplicate"), segment_id: z.string().uuid(), digest: z.string() }),
  z.object({ outcome: z.literal("conflict"), conflict_kind: z.enum(["segment_id_changed", "index_reused"]), digest: z.string() }),
])

const body = (data: unknown): unknown => (typeof data === "string" ? JSON.parse(data) : data)

/** Redact, then store one segment if (and only if) the capture gate allows its exact time. */
export async function recordTranscriptSegment(
  db: SupabaseClient,
  input: { shopId: string; callId: string; segment: unknown },
): Promise<SegmentOutcome> {
  const ids = z.object({ shopId: uuid, callId: uuid }).safeParse({ shopId: input.shopId, callId: input.callId })
  const seg = transcriptSegmentSchema.safeParse(input.segment)
  if (!ids.success || !seg.success) return { outcome: "invalid" }
  const started = Date.parse(seg.data.startedAt)
  const ended = Date.parse(seg.data.endedAt)
  if (!(ended > started)) return { outcome: "invalid" }

  const redacted = redactTranscriptText(seg.data.text)
  if (redacted.text.trim().length === 0) return { outcome: "invalid" }

  const { data, error } = await db.rpc("call_copilot_record_segment", {
    p_shop: ids.data.shopId,
    p_call: ids.data.callId,
    p_index: seg.data.index,
    p_provider_segment_id: seg.data.providerSegmentId,
    p_speaker: seg.data.speaker,
    p_started_at: seg.data.startedAt,
    p_ended_at: seg.data.endedAt,
    p_text: redacted.text,
    p_redactions: redacted.redactions,
  })
  if (error) {
    if (error.code === "CC403") return { outcome: "denied", reason: error.details?.trim() || "capture_not_permitted" }
    if (error.code === "22023" || error.code === "23514") return { outcome: "invalid" }
    // Message only; never echo the segment.
    throw new TranscriptError(`Transcript segment was not recorded (${error.code ?? "unknown"}).`)
  }
  const parsed = segmentResult.safeParse(body(data))
  if (!parsed.success) throw new TranscriptError("Transcript segment result could not be read.")
  const r = parsed.data
  if (r.outcome === "recorded") return { outcome: "recorded", segmentId: r.segment_id, redactions: redacted.redactions }
  if (r.outcome === "duplicate") return { outcome: "duplicate", segmentId: r.segment_id }
  return { outcome: "conflict", conflictKind: r.conflict_kind }
}

// ---------------------------------------------------------------------------
// Evidence revisions
// ---------------------------------------------------------------------------

export const COVERAGE_REASONS = [
  "completion_not_attested", "call_not_ended", "provider_outcome_unknown", "capture_gap",
  "segment_holes", "segment_count_unconfirmed", "segment_count_mismatch",
] as const

export type Coverage = { status: "complete" | "partial"; reasons: string[] }

const sealResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("empty") }),
  z.object({
    outcome: z.enum(["sealed", "unchanged"]),
    evidence_revision_id: z.string().uuid(),
    revision: z.number().int().positive(),
    coverage_status: z.enum(["complete", "partial"]),
    coverage_reasons: z.array(z.string()),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
])

export type SealOutcome =
  | { outcome: "sealed" | "unchanged"; evidenceRevisionId: string; revision: number; digest: string; coverage: Coverage }
  | { outcome: "empty" }
  | { outcome: "denied"; reason: string }
  | { outcome: "unauthorized" }

/**
 * Seal what has been captured so far as a stable evidence revision. Pass `declaredFinal` and the
 * provider-attested `expectedSegmentCount` ONLY when the provider asserted the transcript is final;
 * otherwise the revision is recorded as partial with the reasons. Completeness is never inferred.
 */
export async function sealEvidence(
  db: SupabaseClient,
  input: { shopId: string; actorId: string; callId: string; declaredFinal: boolean; expectedSegmentCount?: number | null },
): Promise<SealOutcome> {
  const ids = z.object({ a: uuid, b: uuid, c: uuid }).safeParse({ a: input.shopId, b: input.actorId, c: input.callId })
  if (!ids.success) return { outcome: "denied", reason: "invalid_identifier" }
  const { data, error } = await db.rpc("call_copilot_seal_evidence", {
    p_shop: input.shopId,
    p_actor: input.actorId,
    p_call: input.callId,
    p_declared_final: input.declaredFinal,
    p_expected: input.expectedSegmentCount ?? null,
  })
  if (error) {
    if (error.code === "CC403") return { outcome: "denied", reason: error.details?.trim() || "capture_not_permitted" }
    if (error.code === "42501") return { outcome: "unauthorized" }
    throw new TranscriptError(`Evidence was not sealed (${error.code ?? "unknown"}).`)
  }
  const parsed = sealResult.safeParse(body(data))
  if (!parsed.success) throw new TranscriptError("Evidence result could not be read.")
  const r = parsed.data
  if (r.outcome === "empty") return { outcome: "empty" }
  return {
    outcome: r.outcome,
    evidenceRevisionId: r.evidence_revision_id,
    revision: r.revision,
    digest: r.digest,
    coverage: { status: r.coverage_status, reasons: r.coverage_reasons },
  }
}

const transcriptRead = z.object({
  evidence_revision_id: z.string().uuid(),
  revision: z.number().int().positive(),
  digest: z.string(),
  coverage_status: z.enum(["complete", "partial"]),
  coverage_reasons: z.array(z.string()),
  segment_count: z.number().int().nonnegative(),
  capture_status: z.string(),
  capture_reason: z.string(),
  call_ended: z.boolean(),
  outcome_unknown: z.boolean(),
  gaps: z.array(z.object({ started_at: z.string(), ended_at: z.string().nullable(), reason: z.string() }).passthrough()),
  segments: z.array(
    z.object({
      segment_id: z.string().uuid(),
      index: z.number().int(),
      speaker: z.enum(["operator", "caller", "unknown"]),
      text: z.string(),
      started_at: z.string(),
      ended_at: z.string(),
      redactions: z.array(z.string()),
    }),
  ),
})

export type EvidenceTranscript = {
  evidenceRevisionId: string
  revision: number
  digest: string
  coverage: Coverage
  captureStatus: string
  callEnded: boolean
  outcomeUnknown: boolean
  gaps: { startedAt: string; endedAt: string | null; reason: string }[]
  segments: { segmentId: string; index: number; speaker: "operator" | "caller" | "unknown"; text: string; startedAt: string; endedAt: string; redacted: boolean }[]
}

export type ReadOutcome =
  | { outcome: "ok"; transcript: EvidenceTranscript }
  | { outcome: "denied"; reason: string }
  | { outcome: "stale"; reason: string }
  | { outcome: "too_large" }
  | { outcome: "unauthorized" }

/** Gated read for a model/extractor: refuses a stale revision and any consent that is not intact. */
export async function readEvidenceTranscript(
  db: SupabaseClient,
  input: { shopId: string; actorId: string; callId: string; evidenceRevisionId: string },
): Promise<ReadOutcome> {
  const ids = z.object({ a: uuid, b: uuid, c: uuid, d: uuid }).safeParse({
    a: input.shopId, b: input.actorId, c: input.callId, d: input.evidenceRevisionId,
  })
  if (!ids.success) return { outcome: "denied", reason: "invalid_identifier" }
  const { data, error } = await db.rpc("call_copilot_read_transcript", {
    p_shop: input.shopId, p_actor: input.actorId, p_call: input.callId, p_revision: input.evidenceRevisionId,
  })
  if (error) {
    if (error.code === "CC403") return { outcome: "denied", reason: error.details?.trim() || "capture_not_permitted" }
    if (error.code === "PT409") return { outcome: "stale", reason: error.details?.trim() || "evidence_changed" }
    if (error.code === "42501") return { outcome: "unauthorized" }
    if (error.code === "22023") return { outcome: "too_large" }
    throw new TranscriptError(`Transcript could not be read (${error.code ?? "unknown"}).`)
  }
  const parsed = transcriptRead.safeParse(body(data))
  if (!parsed.success) throw new TranscriptError("Transcript result could not be read.")
  const r = parsed.data
  return {
    outcome: "ok",
    transcript: {
      evidenceRevisionId: r.evidence_revision_id,
      revision: r.revision,
      digest: r.digest,
      coverage: { status: r.coverage_status, reasons: r.coverage_reasons },
      captureStatus: r.capture_status,
      callEnded: r.call_ended,
      outcomeUnknown: r.outcome_unknown,
      gaps: r.gaps.map((g) => ({ startedAt: g.started_at, endedAt: g.ended_at, reason: g.reason })),
      segments: r.segments.map((s) => ({
        segmentId: s.segment_id, index: s.index, speaker: s.speaker, text: s.text,
        startedAt: s.started_at, endedAt: s.ended_at, redacted: s.redactions.length > 0,
      })),
    },
  }
}
