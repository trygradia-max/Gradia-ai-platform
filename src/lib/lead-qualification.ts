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
