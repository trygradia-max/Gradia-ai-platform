import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { requireCaptureGrant, CaptureDeniedError } from "./capture-gate"
import { crmContextDigest, loadCrmSnapshot } from "./crm-resolution"
import { EXTRACTION_SCHEMA_VERSION, type ExtractorOutput } from "./extraction-schema"
import { buildExtractorInput, runExtractor, type CallExtractor } from "./extractor"
import { planProposals, type PlanResult, type PlannedProposal } from "./planner"
import { readEvidenceTranscript, type Coverage } from "./transcript"

/**
 * Call Copilot extraction and approval-first proposals (PR E), orchestrated.
 *
 *   gate (model_use) -> gated transcript read -> bounded extractor seam -> strict validation
 *   -> existing CRM resolution -> deterministic planning -> ONE atomic database record
 *
 * What this grants: nothing. Executable proposals become ordinary pending actions in the existing
 * approval queue (APPROVAL REQUIRED); the rest are review-only. No CRM, quote, booking, task or
 * message row is written, no message is sent, no memory is published, and nothing is retried. The
 * existing executor runs an approved proposal only after `control_claim` re-verifies membership,
 * current policy, consent/capture evidence, the sealed evidence revision, the agent definition
 * (when bound) and the CRM identity the proposal was built against.
 *
 * Failure is visible, not silent: every outcome is a typed result, and a failed or unknown-outcome
 * extraction is recorded on a run so a lead is never silently lost. An `unknown_outcome` run is
 * terminal for its identity and is never replayed automatically.
 */

export type ProposeInput = {
  shopId: string
  /** The authenticated member requesting extraction (owner, or a manager with crm.read). */
  actorId: string
  callId: string
  /** From `sealEvidence`. Extraction is bound to this exact revision. */
  evidenceRevisionId: string
  /** The CRM customer this call is already linked to, from trusted server code. Verified by the database. */
  knownCustomerId?: string | null
  /** Optional: bind proposals to an exact active agent definition revision. Re-checked at approval. */
  definition?: { agentId: string; revision: number } | null
  now?: Date
}

export type ProposeOutcome =
  | {
      status: "recorded" | "replayed"
      runId: string
      coverage: Coverage
      proposalIds: string[]
      counts: { executable: number; reviewOnly: number; refused: number; skipped: number; deduplicated: number }
    }
  | { status: "denied"; reason: string }
  | { status: "stale"; reason: string }
  | { status: "unauthorized" }
  | { status: "extraction_failed"; kind: "failed_before_effect" | "unknown_outcome"; code: string; runId: string | null; coverage: Coverage }
  | { status: "too_large" }

const ids = z.object({ shopId: z.string().uuid(), actorId: z.string().uuid(), callId: z.string().uuid(), evidenceRevisionId: z.string().uuid() })

export class ProposalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProposalError"
  }
}

const recorded = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("recorded"), run_id: z.string().uuid(), status: z.string(),
    proposal_ids: z.array(z.string().uuid()), created: z.number().int(), deduplicated: z.number().int(),
  }),
  z.object({ outcome: z.literal("replayed"), run_id: z.string().uuid(), status: z.string(), proposal_ids: z.array(z.string().uuid()) }),
])

type RunRecord = {
  status: "completed" | "unknown_outcome" | "failed_before_effect"
  failureCode?: string
  refusedCount: number
  extractor: { id: string; version: string }
  crmDigest: string
}

async function record(
  db: SupabaseClient,
  input: ProposeInput,
  run: RunRecord,
  planned: PlannedProposal[],
): Promise<
  | { ok: true; value: z.infer<typeof recorded> }
  | { ok: false; outcome: Exclude<ProposeOutcome, { status: "recorded" | "replayed" | "extraction_failed" }> }
> {
  const { data, error } = await db.rpc("call_copilot_record_extraction", {
    p_shop: input.shopId,
    p_actor: input.actorId,
    p_call: input.callId,
    p_revision: input.evidenceRevisionId,
    p_run: {
      status: run.status,
      failure_code: run.failureCode ?? null,
      refused_count: run.refusedCount,
      extractor_id: run.extractor.id,
      extractor_version: run.extractor.version,
      schema_version: EXTRACTION_SCHEMA_VERSION,
      crm_context_digest: run.crmDigest,
      definition_agent_id: input.definition?.agentId ?? null,
      definition_revision: input.definition?.revision ?? null,
    },
    p_proposals: planned,
  })
  if (error) {
    if (error.code === "CC403") return { ok: false, outcome: { status: "denied", reason: error.details?.trim() || "capture_not_permitted" } }
    if (error.code === "PT409") return { ok: false, outcome: { status: "stale", reason: error.details?.trim() || "evidence_changed" } }
    if (error.code === "42501") return { ok: false, outcome: { status: "unauthorized" } }
    throw new ProposalError(`Extraction was not recorded (${error.code ?? "unknown"}).`)
  }
  const parsed = recorded.safeParse(typeof data === "string" ? JSON.parse(data) : data)
  if (!parsed.success) throw new ProposalError("Extraction result could not be read.")
  return { ok: true, value: parsed.data }
}

export async function proposeFromCall(
  db: SupabaseClient,
  deps: { extractor: CallExtractor },
  input: ProposeInput,
): Promise<ProposeOutcome> {
  if (!ids.safeParse(input).success) return { status: "denied", reason: "invalid_identifier" }

  // 1. Gate. Declined, missing, mismatched, paused-gap, stopped, unknown or conflicting consent means
  //    no transcript is read and the extractor is never called. A failure to ask is a denial.
  try {
    await requireCaptureGrant(db, { shopId: input.shopId, callId: input.callId, purpose: "model_use" })
  } catch (e) {
    if (e instanceof CaptureDeniedError) return { status: "denied", reason: e.reason }
    return { status: "denied", reason: "gate_unavailable" }
  }

  // 2. Gated, bounded transcript read for exactly this evidence revision.
  const read = await readEvidenceTranscript(db, {
    shopId: input.shopId, actorId: input.actorId, callId: input.callId, evidenceRevisionId: input.evidenceRevisionId,
  })
  if (read.outcome === "denied") return { status: "denied", reason: read.reason }
  if (read.outcome === "stale") return { status: "stale", reason: read.reason }
  if (read.outcome === "unauthorized") return { status: "unauthorized" }
  if (read.outcome === "too_large") return { status: "too_large" }
  const transcript = read.transcript
  const coverage = transcript.coverage

  // 2b. An earlier unknown-outcome run for this evidence and extractor identity is terminal: the seam may have
  //     processed the transcript, so it is NEVER called again automatically. Surfaced for a human instead.
  const extractor = deps.extractor
  const prior = await db.rpc("call_copilot_find_unknown_run", {
    p_shop: input.shopId, p_actor: input.actorId, p_call: input.callId, p_revision: input.evidenceRevisionId,
    p_extractor_id: extractor.id, p_extractor_version: extractor.version, p_schema_version: EXTRACTION_SCHEMA_VERSION,
  })
  if (prior.error) throw new ProposalError(`Extraction history could not be read (${prior.error.code ?? "unknown"}).`)
  if (typeof prior.data === "string" && z.string().uuid().safeParse(prior.data).success) {
    return { status: "extraction_failed", kind: "unknown_outcome", code: "previous_outcome_unknown", runId: prior.data, coverage }
  }

  // 3. Bounded extractor seam. Its output is untrusted and re-validated against a strict closed schema.
  const result = await runExtractor(extractor, buildExtractorInput(transcript))
  const emptyDigest = crmContextDigest({ byPhone: {}, byEmail: {}, byName: {}, known: null, vehiclesByCustomer: {} })
  if (!result.ok) {
    // Recorded so the failure is visible. Nothing is staged and nothing is retried automatically.
    const rec = await record(db, input, {
      status: result.kind, failureCode: result.code, refusedCount: 0,
      extractor: { id: extractor.id, version: extractor.version }, crmDigest: emptyDigest,
    }, [])
    return {
      status: "extraction_failed", kind: result.kind, code: result.code,
      runId: rec.ok ? rec.value.run_id : null, coverage,
    }
  }
  const output: ExtractorOutput = result.output

  // 4. Existing customer/vehicle resolution (read-only), then deterministic planning.
  const crm = await loadCrmSnapshot(db, { shopId: input.shopId, output, knownCustomerId: input.knownCustomerId })
  const plan: PlanResult = planProposals(output, {
    callId: input.callId,
    evidence: { revisionId: transcript.evidenceRevisionId, revision: transcript.revision },
    segments: new Map(transcript.segments.map((s) => [s.index, { index: s.index, text: s.text }])),
    crm,
    now: input.now ?? new Date(),
  })

  // 5. One atomic record: run + proposals + staging of executable proposals as pending actions.
  const rec = await record(db, input, {
    status: "completed", refusedCount: plan.refused.length,
    extractor: { id: extractor.id, version: extractor.version }, crmDigest: crmContextDigest(crm),
  }, plan.planned)
  if (!rec.ok) return rec.outcome
  const executable = plan.planned.filter((p) => p.route === "pending_action").length
  return {
    status: rec.value.outcome,
    runId: rec.value.run_id,
    coverage,
    proposalIds: rec.value.proposal_ids,
    counts: {
      executable,
      reviewOnly: plan.planned.length - executable,
      refused: plan.refused.length,
      skipped: plan.skipped.length,
      deduplicated: rec.value.outcome === "recorded" ? rec.value.deduplicated : plan.planned.length,
    },
  }
}

/**
 * Hand a customer-specific memory proposal to the EXISTING reviewed-memory candidate lifecycle. Call it
 * with an OWNER SESSION client (the existing candidate function requires `auth.uid()`). The text is the
 * proposal's stored, cited value; the candidate is inert until the existing review and publication.
 */
export async function submitMemoryCandidate(
  ownerSession: SupabaseClient,
  input: { shopId: string; proposalId: string },
): Promise<
  | { outcome: "submitted" | "already_submitted"; sourceId: string; revision: number }
  | { outcome: "denied"; reason: string }
> {
  if (!z.string().uuid().safeParse(input.shopId).success || !z.string().uuid().safeParse(input.proposalId).success) {
    return { outcome: "denied", reason: "invalid_identifier" }
  }
  const { data, error } = await ownerSession.rpc("call_copilot_submit_memory_candidate", {
    p_shop: input.shopId, p_proposal: input.proposalId,
  })
  if (error) {
    if (error.code === "42501") return { outcome: "denied", reason: error.details?.trim() || "owner_required" }
    if (error.code === "CC403") return { outcome: "denied", reason: error.details?.trim() || "capture_not_permitted" }
    if (error.code === "PT409") return { outcome: "denied", reason: error.details?.trim() || "evidence_changed" }
    if (error.code === "22023") return { outcome: "denied", reason: "not_submittable" }
    throw new ProposalError(`Memory candidate was not submitted (${error.code ?? "unknown"}).`)
  }
  const parsed = z
    .object({ outcome: z.enum(["submitted", "already_submitted"]), source_id: z.string().uuid(), revision: z.number().int() })
    .safeParse(typeof data === "string" ? JSON.parse(data) : data)
  if (!parsed.success) throw new ProposalError("Memory candidate result could not be read.")
  return { outcome: parsed.data.outcome, sourceId: parsed.data.source_id, revision: parsed.data.revision }
}
