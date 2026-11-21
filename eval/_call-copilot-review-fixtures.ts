import type { ReviewDetail, ReviewProposal } from "@/lib/call-copilot/review-dto"

/** Synthetic review DTOs. No real people, numbers or provider ids. */
export const CALL_ID = "11111111-1111-4111-8111-111111111111"
export const SHOP_ID = "22222222-2222-4222-8222-222222222222"
const SET = "a".repeat(64)
const hex = (n: number) => n.toString(16).padStart(64, "0")
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`

export const cite = (over: Partial<ReviewProposal["fields"][number]["citations"][number]> = {}) => ({
  speaker: "caller" as const, at: "2026-11-20T15:03:10Z", segment_index: 0, state: "shown" as const,
  snippet: "My phone is plus one five five five zero one four two", ...over,
})

export function proposal(over: Partial<ReviewProposal> & { n?: number } = {}): ReviewProposal {
  const n = over.n ?? 1
  const { n: _n, ...rest } = over
  void _n
  return {
    id: uuid(n), kind: "customer", route: "pending_action", action_type: "resolve_customer", action_id: uuid(1000 + n),
    review_reason: null, confidence: "high", ambiguity: null, created_at: `2026-11-20T15:10:0${n % 10}Z`, set_id: SET,
    requested_by_me: true, definition_bound: false, customer: null,
    staged: { name: "Jordan Lee", phone: "+15555550142", email: null },
    status: "pending", executed: false, decided_at: null, freshness: null,
    fields: [{ name: "name", value: "Jordan Lee", confidence: "high", citations: [cite({ snippet: "This is Jordan Lee" })] }],
    review_token: hex(n), ...rest,
  }
}

export const vehicle = (n = 2, over: Partial<ReviewProposal> = {}) => proposal({
  n, kind: "vehicle", action_type: "update_customer", customer: { id: uuid(500), name: "Jordan Lee" },
  staged: { customer_id: uuid(500), before: { name: "Jordan Lee", phone: "+15555550142", email: null }, expected_updated_at: "2026-11-01T00:00:00Z", changes: {},
    vehicle: { before: null, id: null, expected_updated_at: null, changes: { year: 2021, make: "Tesla", model: "Model 3", color: "white" } } },
  fields: [{ name: "make", value: "Tesla", confidence: "high", citations: [cite({ snippet: "a white 2021 Tesla Model 3" })] }],
  ...over,
})
export const customerChange = (n = 1, over: Partial<ReviewProposal> = {}) => proposal({ n, kind: "customer", customer: { id: uuid(500), name: "Jordan Lee" }, ...over })
export const quote = (n = 3, over: Partial<ReviewProposal> = {}) => proposal({
  n, kind: "quote_draft", action_type: "create_quote", customer: { id: uuid(500), name: "Jordan Lee" },
  staged: { customer_name: "Jordan Lee", phone: "+15555550142", car_info: "2021 Tesla Model 3", services: ["Full detail"], notes: null },
  fields: [{ name: "services", value: ["Full detail"], confidence: "high", citations: [cite({ snippet: "a full detail please" })] }], ...over,
})
export const booking = (n = 4, over: Partial<ReviewProposal> = {}) => proposal({
  n, kind: "appointment_draft", action_type: "book_appointment", customer: { id: uuid(500), name: "Jordan Lee" },
  staged: { iso_start_time: "2026-12-04T17:00:00Z", duration_minutes: 180, service: "Full detail", car_info: "2021 Tesla Model 3" },
  fields: [{ name: "start", value: "2026-12-04T17:00:00Z", confidence: "high", citations: [cite({ snippet: "December fourth at nine a.m." })] }], ...over,
})
export const message = (n = 5, over: Partial<ReviewProposal> = {}) => proposal({
  n, kind: "message_draft", action_type: "send_sms", customer: { id: uuid(500), name: "Jordan Lee" },
  staged: { to_phone: "+15555550142", body: "Thanks for calling. We'll see you on the fourth." },
  fields: [{ name: "body", value: "Thanks for calling.", confidence: "medium", citations: [cite({ snippet: "send me a confirmation" })] }], ...over,
})
export const note = (n = 6, over: Partial<ReviewProposal> = {}) => proposal({
  n, kind: "service_request", action_type: "record_interaction", customer: { id: uuid(500), name: "Jordan Lee" },
  staged: { customer_id: uuid(500), channel: "note", role: "system", content: "Call note: Requested service: full detail", metadata: {} },
  fields: [{ name: "service", value: "full detail", confidence: "high", citations: [cite()] }], ...over,
})
export const reviewOnly = (n = 7, over: Partial<ReviewProposal> = {}) => proposal({
  n, kind: "memory_candidate", route: "review_only", action_type: null, action_id: null, staged: null, status: null, executed: null,
  review_reason: "customer_memory_review_only", customer: { id: uuid(500), name: "Jordan Lee" },
  fields: [{ name: "memory", value: "Prefers morning drop-off", confidence: "medium", citations: [cite({ snippet: "I always drop it off in the morning" })] }], ...over,
})

export function detail(over: Partial<Extract<ReviewDetail, { found: true }>> = {}): Extract<ReviewDetail, { found: true }> {
  return {
    found: true, viewer_role: "owner", can_approve: true,
    call: { id: CALL_ID, created_at: "2026-11-20T15:00:00Z" },
    capture: {
      status: "ended", reason: "call_ended", capture_permitted_now: false, derivation_permitted: true, call_ended: true, outcome_unknown: false,
      unresolved_gap: false, conflict_count: 0, transcript_conflicts: 0, segments_stored: 12,
      intervals: [{ started_at: "2026-11-20T15:01:00Z", ended_at: "2026-11-20T15:08:00Z", end_reason: "call_ended" }],
      gaps: [{ started_at: "2026-11-20T15:00:00Z", ended_at: "2026-11-20T15:01:00Z", reason: "before_consent" }],
      review_permitted: true, review_denied_reason: null,
    },
    evidence: {
      revisions: [{ revision: 1, created_at: "2026-11-20T15:09:00Z", coverage_status: "complete", coverage_reasons: [], segment_count: 12, declared_final: true, expected_segment_count: 12, call_ended: true, outcome_unknown: false, is_latest: true }],
      selected: { revision: 1, is_latest: true, current: true, not_current_reason: null, coverage_status: "complete", coverage_reasons: [], segment_count: 12, declared_final: true, expected_segment_count: 12, gaps: [] },
    },
    runs: [{ status: "completed", failure_code: null, refused_count: 0, proposal_count: 2, extractor: "fixture@1", revision: 1, created_at: "2026-11-20T15:10:00Z", requested_by_me: true, definition_bound: false }],
    proposals: [vehicle(2), customerChange(1)],
    proposals_total: 2, proposals_truncated: false, snippets_withheld: false,
    ...over,
  }
}
