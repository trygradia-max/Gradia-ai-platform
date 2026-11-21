import { z } from "zod"

/**
 * Call Copilot review (PR F): the server DTOs for the two read-only review RPCs
 * (`call_copilot_review_list`, `call_copilot_review_detail`).
 *
 * The database already limits what these functions return (authority from `auth.uid()`, minimum cited snippets,
 * the consent/evidence gate). This layer is the second, fail-closed parse: anything that does not match
 * is an error, never a guess, and only the fields declared here reach a component (unknown keys are stripped, so
 * a future database column cannot leak to the browser by accident).
 *
 * This module imports nothing from the rest of the app.
 */

const iso = z.string().min(1).max(40)
const uuid = z.string().uuid()
/** Pending-action ids for a proposal are derived (a hash laid out as a uuid), so they are not RFC-versioned. Shape only. */
const uuidShaped = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const code = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)

export const PROPOSAL_KINDS = [
  "customer", "vehicle", "service_request", "timing", "lead", "quote_draft",
  "appointment_draft", "followup_task", "message_draft", "memory_candidate",
] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

export const ACTION_TYPES = ["resolve_customer", "update_customer", "record_interaction", "create_quote", "book_appointment", "send_sms"] as const
export type ProposalActionType = (typeof ACTION_TYPES)[number]

const confidence = z.enum(["low", "medium", "high"])

export const CAPTURE_STATUSES = [
  "unknown_call", "awaiting_consent", "active", "paused", "declined", "stopped", "ended", "unknown_outcome", "uncertain",
] as const
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number]

export const SNIPPET_STATES = ["shown", "withheld", "span_not_captured", "mismatch", "redacted", "unavailable", "not_loaded"] as const
export type SnippetState = (typeof SNIPPET_STATES)[number]

const citation = z.object({
  speaker: z.enum(["operator", "caller", "unknown"]),
  at: iso,
  segment_index: z.number().int().min(0),
  state: z.enum(SNIPPET_STATES),
  snippet: z.string().max(400).optional(),
})
export type ReviewCitation = z.infer<typeof citation>

const field = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  value: z.unknown(),
  confidence,
  citations: z.array(citation).min(1).max(5),
})
export type ReviewField = z.infer<typeof field>

const ambiguity = z.object({
  candidate_customers: z.number().int().min(0).optional(),
  candidate_vehicles: z.number().int().min(0).optional(),
  existing_vehicles: z.number().int().min(0).optional(),
  conflicts: z.array(z.object({ field: z.string(), crm: z.string(), heard: z.string() })).optional(),
  ungrounded_fields: z.array(z.string()).optional(),
  invalid_fields: z.array(z.string()).optional(),
  invalid_payload: z.boolean().optional(),
  note: z.string().max(200).optional(),
})
export type ReviewAmbiguity = z.infer<typeof ambiguity>

const proposal = z.object({
  id: uuid,
  kind: z.enum(PROPOSAL_KINDS),
  route: z.enum(["pending_action", "review_only"]),
  action_type: z.enum(ACTION_TYPES).nullable(),
  action_id: uuidShaped.nullable(),
  review_reason: code.nullable(),
  confidence,
  ambiguity: ambiguity.nullable(),
  created_at: iso,
  /** Opaque: groups proposals of ONE requester over ONE evidence revision (the dependency scope). */
  set_id: z.string().regex(/^[0-9a-f]{64}$/),
  requested_by_me: z.boolean(),
  definition_bound: z.boolean(),
  customer: z.object({ id: uuid, name: z.string().nullable() }).nullable(),
  staged: z.record(z.string(), z.unknown()).nullable(),
  /** Pending-action status for an executable proposal; null for a review-only one. */
  status: z.enum(["pending", "approved", "edit_requested", "rejected"]).nullable(),
  executed: z.boolean().nullable(),
  decided_at: iso.nullable(),
  /** Why the proposal could not be acted on right now (the claim's own checks), or null when nothing changed. */
  freshness: code.nullable(),
  fields: z.array(field).min(1).max(20),
  /** What the reviewer saw. The approve action refuses when this has changed. */
  review_token: z.string().regex(/^[0-9a-f]{64}$/),
})
export type ReviewProposal = z.infer<typeof proposal>

const interval = z.object({ started_at: iso, ended_at: iso.nullable(), end_reason: z.string().nullable() })
const gap = z.object({ started_at: iso, ended_at: iso.nullable(), reason: z.string() })

const capture = z.object({
  status: z.enum(CAPTURE_STATUSES),
  reason: z.string(),
  capture_permitted_now: z.boolean(),
  derivation_permitted: z.boolean(),
  call_ended: z.boolean(),
  outcome_unknown: z.boolean(),
  unresolved_gap: z.boolean(),
  conflict_count: z.number().int().min(0),
  transcript_conflicts: z.number().int().min(0),
  segments_stored: z.number().int().min(0),
  intervals: z.array(interval),
  gaps: z.array(gap),
  review_permitted: z.boolean(),
  review_denied_reason: z.string().nullable(),
})
export type ReviewCapture = z.infer<typeof capture>

const coverageStatus = z.enum(["complete", "partial"])
const coverageReasons = z.array(z.string())

const revisionSummary = z.object({
  revision: z.number().int().min(1),
  created_at: iso,
  coverage_status: coverageStatus,
  coverage_reasons: coverageReasons,
  segment_count: z.number().int().min(0),
  declared_final: z.boolean(),
  expected_segment_count: z.number().int().nullable(),
  call_ended: z.boolean(),
  outcome_unknown: z.boolean(),
  is_latest: z.boolean(),
})
export type ReviewRevision = z.infer<typeof revisionSummary>

const selectedEvidence = z.object({
  revision: z.number().int().min(1),
  is_latest: z.boolean(),
  current: z.boolean(),
  not_current_reason: z.string().nullable(),
  coverage_status: coverageStatus,
  coverage_reasons: coverageReasons,
  segment_count: z.number().int().min(0),
  declared_final: z.boolean(),
  expected_segment_count: z.number().int().nullable(),
  gaps: z.array(gap),
})
export type ReviewEvidence = z.infer<typeof selectedEvidence>

const run = z.object({
  status: z.enum(["completed", "unknown_outcome", "failed_before_effect"]),
  failure_code: code.nullable(),
  refused_count: z.number().int().min(0),
  proposal_count: z.number().int().min(0),
  extractor: z.string(),
  revision: z.number().int().min(1),
  created_at: iso,
  requested_by_me: z.boolean(),
  definition_bound: z.boolean(),
})
export type ReviewRun = z.infer<typeof run>

export const reviewDetailSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    viewer_role: z.enum(["owner", "manager"]),
    can_approve: z.boolean(),
    call: z.object({ id: uuid, created_at: iso }),
    capture,
    evidence: z.object({ revisions: z.array(revisionSummary).max(10), selected: selectedEvidence.nullable() }),
    runs: z.array(run).max(10),
    proposals: z.array(proposal).max(60),
    proposals_total: z.number().int().min(0),
    proposals_truncated: z.boolean(),
    snippets_withheld: z.boolean(),
  }),
])
export type ReviewDetailResult = z.infer<typeof reviewDetailSchema>
export type ReviewDetail = Extract<ReviewDetailResult, { found: true }>

const listItem = z.object({
  call_id: uuid,
  created_at: iso,
  capture_status: z.enum(CAPTURE_STATUSES),
  capture_reason: z.string(),
  call_ended: z.boolean(),
  outcome_unknown: z.boolean(),
  unresolved_gap: z.boolean(),
  latest_revision: z.number().int().nullable(),
  coverage_status: coverageStatus.nullable(),
  proposals: z.object({
    total: z.number().int().min(0), awaiting: z.number().int().min(0), review_only: z.number().int().min(0), decided: z.number().int().min(0),
  }).nullable(),
})
export type ReviewListItem = z.infer<typeof listItem>

export const reviewListSchema = z.object({
  viewer_role: z.enum(["owner", "manager"]),
  can_approve: z.boolean(),
  items: z.array(listItem).max(25),
  next_cursor: z.object({ created_at: iso, id: uuid }).nullable(),
})
export type ReviewList = z.infer<typeof reviewListSchema>
