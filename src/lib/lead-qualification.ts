import { z } from "zod"

/**
 * Durable lead qualification contract. PostgreSQL is the authority for every
 * rule here; these schemas mirror it so a caller gets an early, specific
 * validation answer and so responses are checked before they are rendered.
 * Contract and examples: docs/architecture/LEAD_QUALIFICATION.md
 */
export const QUALIFICATION_FIELDS = ["service", "vehicle_condition", "timing", "location", "constraints"] as const
export type QualificationField = (typeof QUALIFICATION_FIELDS)[number]

const controlFree = (value: string) =>
  !Array.from(value).some((c) => (c.charCodeAt(0) < 32 && !"\n\r\t".includes(c)) || c.charCodeAt(0) === 127)
const text = (max: number) =>
  z.string().min(1).max(max).refine((v) => v === v.trim() && controlFree(v), "Trimmed text without control characters")
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Real calendar date")

/** unknown: nobody has established it. reported: stated, not checked. confirmed: a reviewer checked it. */
const status = z.enum(["unknown", "reported", "confirmed"])
/** Who the information came from. `intake` must cite the submission it came from. */
const provenance = {
  status,
  source: z.enum(["customer", "staff", "intake"]).nullable(),
  evidence_revision: z.number().int().positive().max(999_999_999).nullable(),
}
type Provenance = { status: z.infer<typeof status>; source: string | null; evidence_revision: number | null }
const provenanceOk = (f: Provenance) =>
  (f.status === "unknown" ? f.source === null : f.source !== null) &&
  (f.source === "intake" ? f.evidence_revision !== null : f.evidence_revision === null)
const known = (f: Provenance) => f.status !== "unknown"

const service = z.object({ ...provenance, service_id: uuid.nullable(), text: text(200).nullable() }).strict()
  .refine((f) => provenanceOk(f) && known(f) !== (f.service_id === null && f.text === null))
const vehicleCondition = z.object({ ...provenance, text: text(1000).nullable() }).strict()
  .refine((f) => provenanceOk(f) && known(f) === (f.text !== null))
const timing = z.object({ ...provenance, earliest: day.nullable(), latest: day.nullable(), text: text(300).nullable() }).strict()
  .refine((f) => provenanceOk(f) && known(f) !== (f.earliest === null && f.latest === null && f.text === null) && !(f.earliest && f.latest && f.latest < f.earliest))
const location = z.object({ ...provenance, type: z.enum(["shop", "mobile"]).nullable(), area: text(200).nullable() }).strict()
  .refine((f) => provenanceOk(f) && (known(f) ? f.type !== null : f.type === null && f.area === null))
/** A known, empty list means "no constraints". Unknown means nobody has asked. */
const constraints = z.object({ ...provenance, items: z.array(text(200)).max(10) }).strict()
  .refine((f) => provenanceOk(f) && (known(f) || f.items.length === 0))

export const qualificationFieldsSchema = z.object({ service, vehicle_condition: vehicleCondition, timing, location, constraints }).strict()
export type QualificationFields = z.infer<typeof qualificationFieldsSchema>

const question = z.object({
  id: uuid, text: text(500), status: z.enum(["open", "answered", "dropped"]), answer: text(1000).nullable(),
}).strict().refine((q) => (q.status === "answered") === (q.answer !== null))
export const qualificationQuestionsSchema = z.array(question).max(20)
  .refine((items) => new Set(items.map((q) => q.id)).size === items.length, "Question ids must be unique")
export type QualificationQuestion = z.infer<typeof question>

/** Full-document replace, bound to the revision, customer and vehicle the reviewer was shown. */
export const qualificationCommandSchema = z.object({
  shopId: uuid, workflowId: uuid, commandId: uuid,
  revision: z.number().int().min(0).max(2147483646),
  customerId: uuid, vehicleId: uuid.nullable(),
  reviewState: z.enum(["in_progress", "reviewed"]),
  fields: qualificationFieldsSchema, openQuestions: qualificationQuestionsSchema,
}).strict()
export type QualificationCommand = z.infer<typeof qualificationCommandSchema>

export const REVIEW_REASONS = ["identity_in_review", "customer_changed", "vehicle_changed", "new_evidence"] as const
const timestamp = z.string().datetime({ offset: true })
const summary = {
  workflow_id: uuid,
  channel: z.string(),
  last_received_at: timestamp,
  identity: z.object({
    state: z.enum(["identity_review", "identity_linked"]),
    customer_id: uuid.nullable(), customer_name: z.string().nullable(),
    vehicle_id: uuid.nullable(), vehicle_status: z.enum(["unresolved", "confirmed", "needs_review"]),
    vehicle: z.object({ year: z.number().int().nullable(), make: z.string().nullable(), model: z.string().nullable(), color: z.string().nullable() }).nullable(),
    evidence_revision: z.number().int().positive().nullable(),
  }),
  revision: z.number().int().nonnegative(),
  /** not_started: nothing recorded. needs_review: recorded, but identity, vehicle or evidence changed since. */
  review_state: z.enum(["not_started", "in_progress", "reviewed", "needs_review"]),
  recorded_review_state: z.enum(["in_progress", "reviewed"]).nullable(),
  review_reasons: z.array(z.enum(REVIEW_REASONS)),
  missing: z.array(z.enum(["vehicle", ...QUALIFICATION_FIELDS, "open_questions"])),
  completeness: z.enum(["complete", "incomplete"]),
  updated_at: timestamp.nullable(),
  updated_by: z.object({ actor_id: uuid, label: z.string(), role: z.enum(["owner", "manager"]) }).nullable(),
}
export const qualificationSchema = z.object({
  ...summary, fields: qualificationFieldsSchema, open_questions: qualificationQuestionsSchema, can_update: z.boolean(),
})
export type LeadQualification = z.infer<typeof qualificationSchema>
export const qualificationListSchema = z.object({ items: z.array(z.object(summary)).max(21), can_update: z.boolean() })
export type LeadQualificationList = z.infer<typeof qualificationListSchema>
export const qualificationHistorySchema = z.object({
  revision: z.number().int().nonnegative(),
  items: z.array(z.object({
    revision: z.number().int().positive(), review_state: z.enum(["in_progress", "reviewed"]),
    actor_id: uuid, actor_role: z.enum(["owner", "manager"]), actor_label: z.string(), created_at: timestamp,
    fields: qualificationFieldsSchema, open_questions: qualificationQuestionsSchema,
    reviewed_customer_id: uuid, reviewed_vehicle_id: uuid.nullable(), reviewed_evidence_revision: z.number().int().positive(),
  })).max(21),
})
export type LeadQualificationHistory = z.infer<typeof qualificationHistorySchema>

/** Every outcome a caller must handle. Nothing here means a quote, booking or message happened. */
export type QualificationUpdateResult =
  | { ok: true; status: "recorded" | "already_recorded"; qualification: LeadQualification }
  | { ok: false; code: "invalid"; field: string }
  | { ok: false; code: "forbidden" }
  | { ok: false; code: "reference_unavailable"; reference: "customer" | "vehicle" | "service" }
  | { ok: false; code: "revision_conflict" | "command_conflict" | "identity_review_required" | "customer_changed" | "vehicle_changed" }
  | { ok: false; code: "not_confirmed" | "uncertain" }

const conflicts = ["revision_conflict", "command_conflict", "identity_review_required", "customer_changed", "vehicle_changed"] as const
const references = { customer_unavailable: "customer", vehicle_unavailable: "vehicle", service_unavailable: "service" } as const

/** Maps a database refusal to a contract outcome without exposing database text. */
export function qualificationRefusal(error: { code?: string; details?: string | null }): Extract<QualificationUpdateResult, { ok: false }> {
  const detail = typeof error.details === "string" ? error.details : ""
  if (error.code === "22023") return { ok: false, code: "invalid", field: /^[a-z_.]{1,80}$/.test(detail) ? detail : "command" }
  if (error.code === "42501") {
    const reference = references[detail as keyof typeof references]
    return reference ? { ok: false, code: "reference_unavailable", reference } : { ok: false, code: "forbidden" }
  }
  if (error.code === "PT409") {
    const conflict = conflicts.find((c) => c === detail)
    if (conflict) return { ok: false, code: conflict }
  }
  return { ok: false, code: "not_confirmed" }
}

/** The starting document: every field explicitly unknown. */
export function unknownQualificationFields(): QualificationFields {
  const base = { status: "unknown" as const, source: null, evidence_revision: null }
  return {
    service: { ...base, service_id: null, text: null },
    vehicle_condition: { ...base, text: null },
    timing: { ...base, earliest: null, latest: null, text: null },
    location: { ...base, type: null, area: null },
    constraints: { ...base, items: [] },
  }
}

/** Fixed wording, in the order asked. No model writes it, and it names no service, price or time. */
const QUESTION_TEXT: Record<QualificationField, string> = {
  service: "Which service are you interested in?",
  vehicle_condition: "How would you describe the vehicle's current condition?",
  timing: "When would you like to bring it in?",
  location: "Will you be bringing the vehicle to the shop?",
  constraints: "Is there anything we should plan around, such as a deadline or access to the vehicle?",
}
type QuestionBasis = { workflow_id: string; revision: number; evidence_revision: number | null }

/**
 * A suggestion for a reviewer to read, edit or ignore. It is not a message, a
 * draft or an approval: nothing is stored, staged or sent, and `delivery` is
 * always `none`. Being able to read it grants no permission to send it.
 * `basis` is the record it was derived from; discard the suggestion once the
 * record's revision or evidence moves on.
 */
export type NextQualificationQuestion =
  | ({ kind: "question"; delivery: "none"; text: string; basis: QuestionBasis }
      & ({ target: QualificationField; question_id: null } | { target: "open_question"; question_id: string }))
  /** Intake review comes first. No customer-facing question is offered. */
  | { kind: "review_required"; reasons: ((typeof REVIEW_REASONS)[number] | "vehicle_unlinked")[]; basis: QuestionBasis }
  /** Nothing is missing. This is not a statement that the lead can be quoted or booked. */
  | { kind: "none"; reason: "complete"; basis: QuestionBasis }

/**
 * Picks the one next thing to ask from the persisted record. Pure and
 * deterministic. A record in identity review, or no longer current against its
 * customer, vehicle or evidence, yields the review requirement instead. An open
 * question the reviewer already wrote comes first, verbatim; otherwise the
 * first field nobody has established. Only `unknown` is missing: a known empty
 * constraint list is an answer. A vehicle link is settled in intake review,
 * never by asking, so it is reported only once nothing else is left.
 */
export function proposeNextQualificationQuestion(q: LeadQualification): NextQualificationQuestion {
  const basis = { workflow_id: q.workflow_id, revision: q.revision, evidence_revision: q.identity.evidence_revision }
  const unlinked = q.identity.state !== "identity_linked" || q.identity.customer_id === null
  if (unlinked || q.review_state === "needs_review" || q.review_reasons.length > 0) {
    const reasons = unlinked && !q.review_reasons.includes("identity_in_review") ? ["identity_in_review" as const, ...q.review_reasons] : q.review_reasons
    return { kind: "review_required", reasons, basis }
  }
  const open = q.open_questions.find((item) => item.status === "open")
  if (open) return { kind: "question", delivery: "none", target: "open_question", question_id: open.id, text: open.text, basis }
  const target = QUALIFICATION_FIELDS.find((field) => q.fields[field].status === "unknown")
  if (target) return { kind: "question", delivery: "none", target, question_id: null, text: QUESTION_TEXT[target], basis }
  if (q.identity.vehicle_status !== "confirmed") return { kind: "review_required", reasons: ["vehicle_unlinked"], basis }
  return { kind: "none", reason: "complete", basis }
}

/**
 * Queues one reviewed question as a pending message approval through the existing
 * Whisper reply staging. Owner only. It sends nothing; the owner sends from
 * Approvals, through the existing executor and its send-time checks.
 */
export const qualificationQuestionStageSchema = z.object({
  shopId: uuid, workflowId: uuid, commandId: uuid,
  // The proposal's `basis`, copied unchanged. It carries `workflow_id`, which
  // must then name this workflow.
  basis: z.object({ workflow_id: uuid.optional(), revision: z.number().int().min(0).max(2147483646), evidence_revision: z.number().int().positive().nullable() }).strict(),
  target: z.enum([...QUALIFICATION_FIELDS, "open_question"]),
  questionId: uuid.nullable(),
  channel: z.enum(["sms", "email"]),
  conversation: z.object({ latestId: uuid, revision: z.number().int().min(0) }).strict(),
  message: z.object({ body: z.string().trim().min(1).max(8000), subject: z.string().max(200), destination: z.string().min(1).max(254) }).strict(),
}).strict()
  .refine((c) => c.basis.workflow_id === undefined || c.basis.workflow_id === c.workflowId, { path: ["basis"] })
  .refine((c) => (c.target === "open_question") === (c.questionId !== null), { path: ["target"] })
  .refine((c) => c.channel === "email" ? c.message.subject.trim().length > 0 : c.message.subject === "", { path: ["message"] })
  .refine((c) => c.channel === "email" || c.message.body.length <= 1600, { path: ["message"] })
export type QualificationQuestionStage = z.infer<typeof qualificationQuestionStageSchema>

const STAGE_CONFLICTS = [
  "command_conflict", "qualification_changed", "review_required", "question_resolved", "question_pending",
  "contact_blocked", "channel_unavailable", "conversation_changed", "recipient_changed",
] as const

/** Every outcome a caller must handle. `queued` is not sent, approved or a consent decision. */
export type QualificationQuestionStageResult =
  | { ok: true; status: "queued" | "already_queued"; actionId: string; workflowId: string; channel: "sms" | "email" }
  | { ok: false; code: "invalid"; field: string }
  | { ok: false; code: "forbidden" | "policy_blocked" | (typeof STAGE_CONFLICTS)[number] | "not_confirmed" | "uncertain" }

export const qualificationQuestionStagedSchema = z.object({
  status: z.enum(["queued", "already_queued"]), action_id: uuid, workflow_id: uuid, channel: z.enum(["sms", "email"]),
  qualification: z.object({
    workflow_id: uuid, revision: z.number().int(), evidence_revision: z.number().int().nullable(),
    target: z.enum([...QUALIFICATION_FIELDS, "open_question"]), question_id: uuid.nullable(),
  }).strict(),
}).strict()

/** Maps a database refusal to a contract outcome without exposing database text. */
export function qualificationQuestionStageRefusal(error: { code?: string; details?: string | null }): Extract<QualificationQuestionStageResult, { ok: false }> {
  const detail = typeof error.details === "string" ? error.details : ""
  if (error.code === "22023") return { ok: false, code: "invalid", field: ["basis", "target", "channel", "message"].includes(detail) ? detail : "command" }
  if (error.code === "42501") return { ok: false, code: detail === "policy_blocked" ? "policy_blocked" : "forbidden" }
  if (error.code === "PT409") {
    const conflict = STAGE_CONFLICTS.find((c) => c === detail)
    if (conflict) return { ok: false, code: conflict }
  }
  return { ok: false, code: "not_confirmed" }
}
