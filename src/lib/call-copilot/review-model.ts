import type {
  CaptureStatus,
  ProposalKind,
  ReviewDetail,
  ReviewProposal,
  SnippetState,
} from "./review-dto"

/**
 * Call Copilot review (PR F): pure view-model rules. No I/O, no framework, nothing here authorizes anything.
 *
 * It answers three questions in plain words, from the already-validated DTO:
 *   1. What does this proposal do, and what is it built on? (summary, binding, citations)
 *   2. Can it be approved right now, and if not, WHY? (state)
 *   3. In what order must a set of proposals be approved? (dependencies)
 *
 * The database decides every real permission (the approval claim re-verifies consent, evidence, requester, policy,
 * agent definition and CRM identity); this module only explains and orders. A "ready" state is never a promise that
 * approval will succeed, it is the absence of a known reason it will not.
 */

// ---------------------------------------------------------------------------
// Plain-language copy for every machine code the database can show a reviewer
// ---------------------------------------------------------------------------

/** What the denial / stale reasons mean for the reviewer. Unknown codes are never shown raw. */
export const FRESHNESS_COPY: Record<string, string> = {
  call_proposal_unknown: "This proposal could not be found. Nothing can be approved from it.",
  call_proposal_edited: "This proposal was changed after it was made, so it can no longer be approved. Dismiss it and review the call again.",
  call_requester_revoked: "The person who asked Gradia to prepare this no longer has access. Nothing can be approved from it.",
  call_proposal_expired: "The appointment time in this proposal has passed.",
  call_consent_unavailable: "Consent for this call no longer permits using it. Nothing can be approved.",
  call_evidence_changed: "The call evidence changed after this was prepared (for example a new transcript segment or a pause). Review the call again.",
  call_definition_inactive: "The agent version this was prepared under is no longer active.",
  call_crm_state_changed: "The customer record changed after this was prepared. Review the customer, then prepare it again.",
  evidence_superseded: "A newer version of the call evidence exists. This proposal belongs to an older one.",
}
const FRESHNESS_FALLBACK = "This proposal could not be verified just now. Nothing can be approved until it is."

export function freshnessCopy(code: string | null | undefined): string | null {
  if (!code) return null
  return FRESHNESS_COPY[code] ?? FRESHNESS_FALLBACK
}

/** Why a proposal is review-only (shown as "Review only"). */
export const REVIEW_REASON_COPY: Record<string, string> = {
  ambiguous_identity: "More than one customer matches what was said. A person has to choose.",
  ambiguous_vehicle: "More than one vehicle on file could match. A person has to choose.",
  conflicting_crm_value: "What the caller said disagrees with what is on file, so who this is has not been established.",
  customer_memory_review_only: "Customer-specific memory stays review-only.",
  customer_name_missing: "The customer record has no name yet.",
  customer_unresolved: "No single customer is resolved yet. Add or link the customer first, then prepare this again.",
  duration_unconfirmed: "No appointment length was said.",
  duration_ambiguous: "More than one appointment length was mentioned.",
  duration_ungrounded: "The appointment length was not stated in the cited words.",
  identity_conflict: "What was said conflicts with the customer on file.",
  identity_unverified: "There is no phone number or email to verify who this is. A name alone never links or creates a customer.",
  low_confidence: "Gradia was not confident enough about this to propose a change.",
  message_content_unsafe: "The drafted message carries a link, contact detail or sensitive content, so it cannot be sent from here.",
  needs_high_confidence: "Booking needs high confidence in the time and length, and this was not.",
  no_guarded_executor: "Gradia has no safe, approvable way to apply this kind of change yet. Make it yourself.",
  no_new_information: "Nothing new to add. The record already has this.",
  no_verified_phone: "The customer has no verified phone number.",
  policy_does_not_permit_staging: "Your Control Center policy does not let this be queued for approval.",
  second_vehicle_needs_review: "This looks like a second vehicle. A person has to confirm.",
  start_ambiguous: "More than one date or time was mentioned.",
  start_ungrounded: "The date or time was not clearly stated in the cited words.",
  start_unusable: "The appointment time could not be used.",
  timezone_unknown: "The shop's time zone is not set, so the time cannot be confirmed.",
  unsupported_value: "A value could not be confirmed from the call words.",
  vehicle_incomplete: "Not enough about the vehicle was said.",
}
const REVIEW_REASON_FALLBACK = "This needs a person to look at it. It cannot be approved from here."

export function reviewReasonCopy(code: string | null | undefined): string | null {
  if (!code) return null
  return REVIEW_REASON_COPY[code] ?? REVIEW_REASON_FALLBACK
}

export const COVERAGE_REASON_COPY: Record<string, string> = {
  completion_not_attested: "The phone provider has not confirmed the transcript is final.",
  call_not_ended: "The call has not ended.",
  provider_outcome_unknown: "It is not known how the call ended.",
  capture_gap: "Part of the call was not captured (for example it was paused).",
  segment_holes: "Some transcript segments are missing.",
  segment_count_unconfirmed: "The provider did not say how many segments to expect.",
  segment_count_mismatch: "The number of segments received differs from what the provider expected.",
}
export const coverageReasonCopy = (code: string): string =>
  COVERAGE_REASON_COPY[code] ?? "Something about this evidence could not be confirmed."

export const GAP_REASON_COPY: Record<string, string> = {
  before_consent: "Before both people agreed. Nothing was captured.",
  consent_declined: "Someone declined. Nothing was captured.",
  paused: "Capture was paused. Nothing was captured.",
  stopped: "Capture was stopped. Nothing was captured.",
  participant_added: "Another person joined. Capture stopped until everyone agrees.",
  provider_outcome_unknown: "The phone provider lost track of the call. It is not known what was captured.",
  time_regression: "The call's timeline did not make sense, so capture was treated as stopped.",
}
export const gapReasonCopy = (code: string): string => GAP_REASON_COPY[code] ?? "Capture was not active."

export const CAPTURE_STATUS_COPY: Record<CaptureStatus, { label: string; tone: "good" | "warn" | "bad" | "muted"; detail: string }> = {
  active: { label: "Capture active", tone: "good", detail: "Both people agreed and capture is on." },
  ended: { label: "Call ended", tone: "good", detail: "Both people agreed. The call has ended." },
  awaiting_consent: { label: "Waiting for consent", tone: "warn", detail: "Nothing is captured until both people agree." },
  paused: { label: "Capture paused", tone: "warn", detail: "Capture is paused. Resuming needs both people to agree again." },
  stopped: { label: "Capture stopped", tone: "muted", detail: "Capture was stopped for this call." },
  declined: { label: "Consent declined", tone: "bad", detail: "Someone declined. No audio or transcript was captured or sent anywhere." },
  unknown_outcome: { label: "Outcome unknown", tone: "bad", detail: "The phone provider lost track of this call. Gradia will not assume it is complete." },
  uncertain: { label: "Capture uncertain", tone: "bad", detail: "The consent record is not clear, so Gradia treats this call as not captured." },
  unknown_call: { label: "Call not found", tone: "muted", detail: "No record of this call." },
}

export const CAPTURE_REASON_COPY: Record<string, string> = {
  capture_active: "Both people agreed to the same notice.",
  call_ended: "The call ended after consent.",
  call_not_opened: "The call has no recorded start.",
  consent_not_established: "Both people have not agreed to the same notice.",
  paused: "Capture is paused.",
  conflicting_replay: "The phone provider sent conflicting records for this call.",
  sequence_gap: "Some events for this call are missing.",
  unconsented_participant: "Someone joined who has not agreed.",
}
export const captureReasonCopy = (code: string): string => CAPTURE_REASON_COPY[code] ?? "See the capture timeline below."

export const SNIPPET_COPY: Record<Exclude<SnippetState, "shown">, string> = {
  withheld: "Hidden. The call's consent or evidence no longer permits showing it.",
  span_not_captured: "Hidden. This part of the call is outside the captured time.",
  mismatch: "Hidden. The stored words no longer match what was cited.",
  redacted: "Hidden. It looked like payment or sensitive data.",
  unavailable: "Hidden. The cited words could not be found.",
  not_loaded: "Not loaded in this view.",
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const KIND_LABEL: Record<ProposalKind, string> = {
  customer: "Customer",
  vehicle: "Vehicle",
  service_request: "Service request",
  timing: "Timing and constraints",
  lead: "Lead",
  quote_draft: "Quote draft",
  appointment_draft: "Appointment draft",
  followup_task: "Follow-up task",
  message_draft: "Message draft",
  memory_candidate: "Customer note for memory",
}

/** Destination-record groups, in the order the product doc lists them. */
export const KIND_GROUP: Record<ProposalKind, string> = {
  customer: "Customer", vehicle: "Vehicle", service_request: "Notes", timing: "Notes", lead: "Lead",
  quote_draft: "Quote", appointment_draft: "Appointment", followup_task: "Follow-up", message_draft: "Message", memory_candidate: "Memory",
}

export const FIELD_LABEL: Record<string, string> = {
  name: "Name", phone: "Phone", email: "Email", make: "Make", model: "Model", year: "Year", color: "Color",
  service: "Service", services: "Services", condition: "Vehicle condition", location: "Location",
  preferred_timing: "Preferred timing", constraints: "Constraints", start: "Start", start_time: "Start", iso_start_time: "Start",
  duration_minutes: "Length (minutes)", notes: "Notes", body: "Message",
}
export const fieldLabel = (name: string): string =>
  FIELD_LABEL[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())

export const CONFIDENCE_COPY = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" } as const

const SPEAKER_COPY = { operator: "Your team", caller: "Caller", unknown: "Unknown speaker" } as const
export const speakerCopy = (s: keyof typeof SPEAKER_COPY): string => SPEAKER_COPY[s]

/** Field values come from the call. Render them as short plain text; objects and long strings are bounded. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "not said"
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 239)}…` : value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map((v) => displayValue(v)).join(", ")
  return "a structured value"
}

// ---------------------------------------------------------------------------
// What a proposal will do, from the staged payload (never from the model's words about itself)
// ---------------------------------------------------------------------------
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const clip = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export type ChangeLine = { label: string; value: string }
export type ChangeSummary = { headline: string; lines: ChangeLine[]; binding: string | null }

/** The one-sentence "what happens if you approve" plus the exact values. */
export function describeChange(p: ReviewProposal): ChangeSummary {
  const s = p.staged
  const customerName = p.customer?.name?.trim() || null
  const customerRef = p.customer ? (customerName ? `existing customer ${customerName}` : "an existing customer") : null
  if (!s || !p.action_type) {
    // Review-only: describe what was heard, field by field. Nothing here can be approved.
    return {
      headline: `Heard: ${KIND_LABEL[p.kind].toLowerCase()}`,
      lines: p.fields.map((f) => ({ label: fieldLabel(f.name), value: displayValue(f.value) })),
      binding: customerRef ? `About ${customerRef}.` : null,
    }
  }
  switch (p.action_type) {
    case "resolve_customer": {
      const lines: ChangeLine[] = []
      for (const k of ["name", "phone", "email"] as const) if (str(s[k])) lines.push({ label: fieldLabel(k), value: str(s[k])! })
      return {
        headline: p.customer ? "Link this call to an existing customer and fill in what is missing" : "Add a new customer",
        lines,
        binding: p.customer ? `Matched ${customerRef} by phone or email.` : "No customer on file matches this phone or email, so a new one would be created.",
      }
    }
    case "update_customer": {
      const vehicle = rec(s.vehicle)
      if (vehicle) {
        const ch = rec(vehicle.changes) ?? {}
        const lines: ChangeLine[] = []
        for (const k of ["year", "make", "model", "color"] as const) if (ch[k] !== undefined && ch[k] !== null) lines.push({ label: fieldLabel(k), value: String(ch[k]) })
        const existing = typeof vehicle.id === "string" && vehicle.id
        return {
          headline: existing ? "Fill in missing details on the customer's vehicle" : "Add a vehicle to the customer",
          lines,
          binding: `${existing ? "Updates a vehicle already on file" : "Adds a new vehicle"} for ${customerRef ?? "this customer"}. Approve this before any change to the customer.`,
        }
      }
      const ch = rec(s.changes) ?? {}
      const lines: ChangeLine[] = []
      for (const k of ["name", "phone", "email"] as const) if (str(ch[k])) lines.push({ label: fieldLabel(k), value: str(ch[k])! })
      return { headline: "Update the customer", lines, binding: customerRef ? `Changes ${customerRef}.` : null }
    }
    case "record_interaction":
      return {
        headline: "Save a note on the customer record",
        lines: [{ label: "Note", value: clip(str(s.content) ?? "") }],
        binding: customerRef ? `Saved to ${customerRef}. Nothing is sent to the customer.` : "Nothing is sent to the customer.",
      }
    case "create_quote": {
      const services = Array.isArray(s.services) ? s.services.filter((x): x is string => typeof x === "string") : []
      const lines: ChangeLine[] = [{ label: "Services", value: services.length ? services.join(", ") : "none named" }]
      if (str(s.car_info)) lines.push({ label: "Vehicle", value: str(s.car_info)! })
      if (str(s.notes)) lines.push({ label: "Notes", value: clip(str(s.notes)!) })
      return {
        headline: "Draft a quote from your service menu",
        lines,
        binding: "Prices come from your menu when you approve, never from the call. Approving drafts the quote; it does not send it.",
      }
    }
    case "book_appointment": {
      const lines: ChangeLine[] = []
      if (str(s.iso_start_time)) lines.push({ label: "Start", value: str(s.iso_start_time)! })
      if (typeof s.duration_minutes === "number") lines.push({ label: "Length (minutes)", value: String(s.duration_minutes) })
      if (str(s.service)) lines.push({ label: "Service", value: str(s.service)! })
      if (str(s.car_info)) lines.push({ label: "Vehicle", value: str(s.car_info)! })
      return {
        headline: "Book an appointment",
        lines,
        binding: "Availability is checked again when you approve. A conflict stops it.",
      }
    }
    case "send_sms":
      return {
        headline: "Send a text message",
        lines: [
          ...(str(s.to_phone) ? [{ label: "To", value: str(s.to_phone)! }] : []),
          { label: "Message", value: clip(str(s.body) ?? "", 480) },
        ],
        binding: "Sent only if the customer's own consent, opt-out status and quiet hours allow it. Approving is not a delivery receipt.",
      }
  }
}

// ---------------------------------------------------------------------------
// State of a proposal
// ---------------------------------------------------------------------------
export type ProposalState =
  | { kind: "ready" }
  | { kind: "review_only" }
  | { kind: "blocked_by"; prerequisites: ProposalKind[] }
  | { kind: "stale"; reason: string }
  | { kind: "approved"; executed: boolean }
  | { kind: "dismissed" }
  | { kind: "edit_requested" }

/** Kinds that must be decided first. A vehicle runs before any customer change; a quote, booking or message waits for both. */
export const PREREQUISITES: Record<ProposalKind, readonly ProposalKind[]> = {
  vehicle: [],
  customer: ["vehicle"],
  service_request: ["vehicle", "customer"],
  timing: ["vehicle", "customer"],
  quote_draft: ["vehicle", "customer"],
  appointment_draft: ["vehicle", "customer"],
  message_draft: ["vehicle", "customer", "quote_draft", "appointment_draft"],
  lead: [], followup_task: [], memory_candidate: [],
}

/** Deterministic approval order: prerequisites first, then creation time, then id. */
const ORDER: Record<ProposalKind, number> = {
  vehicle: 0, customer: 1, service_request: 2, timing: 2, quote_draft: 3, appointment_draft: 3, message_draft: 4,
  lead: 9, followup_task: 9, memory_candidate: 9,
}

export const isExecutable = (p: ReviewProposal): boolean => p.route === "pending_action" && p.action_id !== null
const isUndecided = (p: ReviewProposal): boolean => p.status === "pending" || p.status === "edit_requested"

export function compareForApproval(a: ReviewProposal, b: ReviewProposal): number {
  return ORDER[a.kind] - ORDER[b.kind] || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Undecided executable proposals of the same set (one requester, one evidence revision) that must be decided first. */
export function undecidedPrerequisites(p: ReviewProposal, all: readonly ReviewProposal[]): ReviewProposal[] {
  const needs = new Set<ProposalKind>(PREREQUISITES[p.kind])
  if (needs.size === 0) return []
  return all.filter((q) => q.id !== p.id && q.set_id === p.set_id && isExecutable(q) && isUndecided(q) && needs.has(q.kind))
}

export function proposalState(p: ReviewProposal, all: readonly ReviewProposal[]): ProposalState {
  if (!isExecutable(p)) return { kind: "review_only" }
  if (p.status === "approved") return { kind: "approved", executed: p.executed === true }
  if (p.status === "rejected") return { kind: "dismissed" }
  if (p.freshness) return { kind: "stale", reason: p.freshness }
  if (p.status === "edit_requested") return { kind: "edit_requested" }
  const blockers = undecidedPrerequisites(p, all)
  if (blockers.length) return { kind: "blocked_by", prerequisites: [...new Set(blockers.map((b) => b.kind))] }
  return { kind: "ready" }
}

/** True when the reviewer may press Approve on this proposal right now (the database still decides). */
export const canApprove = (p: ReviewProposal, all: readonly ReviewProposal[], viewerCanApprove: boolean): boolean =>
  viewerCanApprove && proposalState(p, all).kind === "ready"

// ---------------------------------------------------------------------------
// Selection planning: the SAME rules the server action enforces, so the UI and the server cannot disagree.
// ---------------------------------------------------------------------------
export const MAX_BULK = 10

export type SelectionRefusal =
  | { ok: false; reason: "empty" | "too_many" | "duplicate" }
  | { ok: false; reason: "unknown_proposal" | "not_approvable" | "changed"; proposalId: string }
  | { ok: false; reason: "missing_prerequisite"; proposalId: string; needs: ProposalKind[] }

export type SelectionPlan = { ok: true; ordered: ReviewProposal[] }

/**
 * Validate a selection against freshly read state and put it in approval order. Refuses the WHOLE selection before
 * anything runs: an unknown, non-executable, stale, blocked or changed proposal, or one whose prerequisite is still
 * undecided and not itself selected.
 */
export function planSelection(
  detail: Pick<ReviewDetail, "proposals">,
  selection: readonly { proposalId: string; reviewToken: string }[],
): SelectionPlan | SelectionRefusal {
  if (selection.length === 0) return { ok: false, reason: "empty" }
  if (selection.length > MAX_BULK) return { ok: false, reason: "too_many" }
  if (new Set(selection.map((s) => s.proposalId)).size !== selection.length) return { ok: false, reason: "duplicate" }
  const byId = new Map(detail.proposals.map((p) => [p.id, p]))
  const chosen: ReviewProposal[] = []
  for (const s of selection) {
    const p = byId.get(s.proposalId)
    if (!p) return { ok: false, reason: "unknown_proposal", proposalId: s.proposalId }
    if (p.review_token !== s.reviewToken) return { ok: false, reason: "changed", proposalId: p.id }
    if (!isExecutable(p) || !isUndecided(p) || p.status === "edit_requested" || p.freshness) {
      return { ok: false, reason: "not_approvable", proposalId: p.id }
    }
    chosen.push(p)
  }
  const chosenIds = new Set(chosen.map((p) => p.id))
  for (const p of chosen) {
    const missing = undecidedPrerequisites(p, detail.proposals).filter((q) => !chosenIds.has(q.id))
    if (missing.length) return { ok: false, reason: "missing_prerequisite", proposalId: p.id, needs: [...new Set(missing.map((q) => q.kind))] }
  }
  return { ok: true, ordered: [...chosen].sort(compareForApproval) }
}

export function selectionRefusalCopy(r: SelectionRefusal): string {
  switch (r.reason) {
    case "empty": return "Select at least one proposal."
    case "too_many": return `Select at most ${MAX_BULK} proposals at a time.`
    case "duplicate": return "The same proposal was selected twice. Nothing was approved."
    case "unknown_proposal": return "A selected proposal is no longer on this call. Nothing was approved. Refresh and review again."
    case "not_approvable": return "A selected proposal can no longer be approved. Nothing was approved. Refresh and review again."
    case "changed": return "A selected proposal changed since you looked at it. Nothing was approved. Review the new version."
    case "missing_prerequisite":
      return `Approve ${r.needs.map((k) => KIND_LABEL[k].toLowerCase()).join(" and ")} first. Nothing was approved.`
  }
}

// ---------------------------------------------------------------------------
// Grouping and headline
// ---------------------------------------------------------------------------
export type ProposalSetView = { setId: string; mine: boolean; proposals: ReviewProposal[] }

/** One section per requester over this evidence revision, proposals in approval order. */
export function groupBySet(proposals: readonly ReviewProposal[]): ProposalSetView[] {
  const sets = new Map<string, ReviewProposal[]>()
  for (const p of proposals) sets.set(p.set_id, [...(sets.get(p.set_id) ?? []), p])
  return [...sets.entries()].map(([setId, ps]) => ({
    setId, mine: ps.some((p) => p.requested_by_me), proposals: [...ps].sort(compareForApproval),
  }))
}

export type ReviewHeadline = { tone: "good" | "warn" | "bad" | "muted"; title: string; detail: string }

/** The one honest line at the top: can this call be used at all, and is the evidence trustworthy and current? */
export function reviewHeadline(d: ReviewDetail): ReviewHeadline {
  if (!d.capture.review_permitted) {
    return {
      tone: "bad",
      title: "This call can't be used",
      detail: "Consent was not established or no longer holds, so Gradia will not use anything from this call.",
    }
  }
  const sel = d.evidence.selected
  if (!sel) {
    return { tone: "muted", title: "No evidence has been prepared yet", detail: "Nothing from this call has been turned into proposals." }
  }
  if (!sel.current) {
    return { tone: "warn", title: "The evidence changed", detail: freshnessCopy(sel.not_current_reason === "evidence_superseded" ? "evidence_superseded" : "call_evidence_changed")! }
  }
  if (sel.coverage_status === "partial") {
    return { tone: "warn", title: "Partial evidence", detail: "Some of this call is missing or unconfirmed. Treat every proposal as incomplete." }
  }
  return { tone: "good", title: "Evidence is complete and current", detail: "Every proposal below cites the call's own words." }
}
