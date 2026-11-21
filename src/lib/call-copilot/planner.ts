import { z } from "zod"

import { recordCommandSchema } from "@/lib/control-center/record-command"
import { mcpProposalSchemas } from "@/lib/mcp/proposal"
import { normalizeDestination } from "@/lib/contact-destination"

import {
  canonicalHeardEmail,
  canonicalHeardPhone,
  nameKey,
  type CrmCustomer,
  type CrmSnapshot,
  type CrmVehicle,
} from "./crm-resolution"
import {
  confidenceRank,
  type Citation,
  type Confidence,
  type ExtractedProposal,
  type ExtractorOutput,
  type ProposalKind,
} from "./extraction-schema"
import { containsSensitive, hasLinkOrContact, looksLikeInstruction } from "./redaction"
import { groundDuration, groundStart } from "./timing-grounding"

/**
 * Deterministic planner (PR E): turns validated extractor output into proposals that the database can
 * record. This is Gradia code, not a model, and it is the ONLY place that decides what a proposal may
 * become:
 *
 *   * a proposal is EXECUTABLE only when an existing guarded operation fits its contract
 *     (resolve_customer, update_customer, record_interaction, create_quote, book_appointment,
 *     send_sms). It is then staged as an ordinary APPROVAL-REQUIRED pending action and the existing
 *     executor runs it only after a human approves.
 *   * everything else (lead stage/owner/next action, follow-up task, customer memory, and anything
 *     ambiguous, conflicting, low-confidence, ungrounded or unverifiable) is REVIEW-ONLY with a reason.
 *   * identity, vehicle, price, availability and consent are never guessed: an exact canonical match
 *     links, several matches are ambiguity, a conflict with a CRM value is shown, not overwritten.
 *   * text that instructs the assistant, or that carries payment-card or other sensitive data, is
 *     REFUSED (dropped and counted) rather than staged or reviewed.
 *
 * The planner never emits a shop id, an actor, a policy, a command id, or a price.
 */

export type SegmentView = { index: number; text: string }
export type PlanContext = {
  callId: string
  evidence: { revisionId: string; revision: number }
  segments: ReadonlyMap<number, SegmentView>
  crm: CrmSnapshot
  now: Date
  /** The shop's IANA timezone, read by trusted server code. Null/invalid means an appointment start cannot be verified. */
  timezone: string | null
}

export type PlannedField = {
  name: string
  value: unknown
  confidence: Confidence
  citations: { segment_index: number; start: number; end: number }[]
}
export type ActionType = "resolve_customer" | "update_customer" | "record_interaction" | "create_quote" | "book_appointment" | "send_sms"
export type PlannedProposal = {
  kind: ProposalKind
  route: "pending_action" | "review_only"
  action_type?: ActionType
  payload?: Record<string, unknown>
  fields: PlannedField[]
  review_reason?: string
  ambiguity?: Record<string, unknown>
  customer_id?: string
  vehicle_id?: string
  /** Identity fields of the CRM customer this proposal used. The database snapshots exactly these and re-checks them at approval. */
  bind?: ("name" | "phone" | "email")[]
  confidence: Confidence
}
export type PlanResult = {
  planned: PlannedProposal[]
  /** Dropped on purpose: never staged, never shown for approval. Counted on the run. */
  refused: { kind: ProposalKind; reason: "invalid_citation" | "suspected_instruction" | "sensitive_content" }[]
  /** Nothing to propose (for example the vehicle is already fully recorded). */
  skipped: { kind: ProposalKind; reason: "no_new_information" }[]
}

// ---------------------------------------------------------------------------
// text helpers (offsets are Unicode code points, matching the database)
// ---------------------------------------------------------------------------
const cp = (s: string): string[] => Array.from(s)
export const spanOf = (text: string, start: number, end: number): string => cp(text).slice(start, end).join("")

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
}
/** Digits in a span, counting spelled-out digits ("five five five") as the numerals they are. */
export function digitsIn(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
  return words.map((w) => (/^\d+$/.test(w) ? w : DIGIT_WORDS[w] ?? "")).join("")
}
const mailForm = (s: string): string =>
  s.toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "")

const minConfidence = (fields: PlannedField[]): Confidence =>
  fields.reduce<Confidence>((m, f) => (confidenceRank(f.confidence) < confidenceRank(m) ? f.confidence : m), "high")

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

type RawField = { value: unknown; confidence: Confidence; citations: Citation[] }
const isRawField = (v: unknown): v is RawField =>
  typeof v === "object" && v !== null && "confidence" in v && "citations" in v && "value" in v

function fieldsOf(p: ExtractedProposal): { name: string; raw: RawField }[] {
  const out: { name: string; raw: RawField }[] = []
  for (const [k, v] of Object.entries(p)) if (isRawField(v)) out.push({ name: snake(k), raw: v })
  return out
}

// ---------------------------------------------------------------------------
// one proposal under construction
// ---------------------------------------------------------------------------
type Built = {
  p: ExtractedProposal
  fields: PlannedField[]
  /** Text of every cited span, keyed by field name, for grounding and hygiene checks. */
  cited: Map<string, string>
  allCited: string
}

type Prepared = { ok: true; built: Built } | { ok: false; refusal: PlanResult["refused"][number] }

function prepare(p: ExtractedProposal, ctx: PlanContext): Prepared {
  const fields: PlannedField[] = []
  const cited = new Map<string, string>()
  for (const { name, raw } of fieldsOf(p)) {
    const spans: string[] = []
    for (const c of raw.citations) {
      const seg = ctx.segments.get(c.segmentIndex)
      if (!seg || c.end > cp(seg.text).length) return { ok: false, refusal: { kind: p.kind, reason: "invalid_citation" } }
      spans.push(spanOf(seg.text, c.start, c.end))
      // Classify the WHOLE utterance, not only the cited words: a narrow span cannot launder instruction text
      // that sits next to it in the same segment.
      if (looksLikeInstruction(seg.text)) return { ok: false, refusal: { kind: p.kind, reason: "suspected_instruction" } }
    }
    cited.set(name, spans.join(" … "))
    fields.push({
      name,
      value: raw.value,
      confidence: raw.confidence,
      citations: raw.citations.map((c) => ({ segment_index: c.segmentIndex, start: c.start, end: c.end })),
    })
  }
  const allCited = [...cited.values()].join(" ")
  if (looksLikeInstruction(allCited) || fields.some((f) => typeof f.value === "string" && looksLikeInstruction(f.value))) {
    return { ok: false, refusal: { kind: p.kind, reason: "suspected_instruction" } }
  }
  const valueText = fields.map((f) => (typeof f.value === "string" ? f.value : JSON.stringify(f.value))).join(" ")
  if (containsSensitive(allCited) || containsSensitive(valueText)) {
    return { ok: false, refusal: { kind: p.kind, reason: "sensitive_content" } }
  }
  return { ok: true, built: { p, fields, cited, allCited } }
}

const review = (
  b: Built, reason: string, extra: { ambiguity?: Record<string, unknown>; customerId?: string; vehicleId?: string } = {},
): PlannedProposal => ({
  kind: b.p.kind,
  route: "review_only",
  fields: b.fields,
  review_reason: reason,
  ambiguity: extra.ambiguity,
  customer_id: extra.customerId,
  vehicle_id: extra.vehicleId,
  confidence: minConfidence(b.fields),
})

const staged = (
  b: Built, action: ActionType, payload: Record<string, unknown>,
  extra: { customerId?: string; vehicleId?: string; bind?: ("name" | "phone" | "email")[] } = {},
): PlannedProposal => ({
  kind: b.p.kind,
  route: "pending_action",
  action_type: action,
  payload,
  fields: b.fields,
  customer_id: extra.customerId,
  vehicle_id: extra.vehicleId,
  bind: extra.bind,
  confidence: minConfidence(b.fields),
})

const lowConfidence = (b: Built): boolean => b.fields.some((f) => f.confidence === "low")
const norm = (s: string | null | undefined): string => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase()

/** Which fields are not literally supported by the span cited for them? Identifiers only: never guessed. */
function ungrounded(b: Built): string[] {
  const bad: string[] = []
  for (const f of b.fields) {
    const span = b.cited.get(f.name) ?? ""
    const lower = span.toLowerCase()
    const v = f.value
    let ok = true
    switch (f.name) {
      case "phone": {
        const want = digitsIn(String(v))
        ok = want.length >= 7 && digitsIn(span).includes(want)
        break
      }
      case "email":
        ok = mailForm(span).includes(mailForm(String(v)))
        break
      case "name": case "make": case "model": case "color": case "year":
        ok = lower.includes(String(v).toLowerCase())
        break
      case "services":
        ok = Array.isArray(v) && v.every((s) => lower.includes(String(s).toLowerCase()))
        break
      default:
        ok = true
    }
    if (!ok) bad.push(f.name)
  }
  return bad
}

const val = <T = string>(b: Built, name: string): T | undefined => b.fields.find((f) => f.name === name)?.value as T | undefined

// ---------------------------------------------------------------------------
// customer
// ---------------------------------------------------------------------------
type Resolution =
  | { kind: "none" }
  | { kind: "one"; customer: CrmCustomer }
  | { kind: "many"; candidates: CrmCustomer[] }

function resolveHeard(b: Built, crm: CrmSnapshot): { res: Resolution; phone: string | null; email: string | null; invalid: string[] } {
  const rawPhone = val(b, "phone")
  const rawEmail = val(b, "email")
  const invalid: string[] = []
  const phone = rawPhone ? canonicalHeardPhone(rawPhone) : null
  const email = rawEmail ? canonicalHeardEmail(rawEmail) : null
  if (rawPhone && !phone) invalid.push("phone")
  if (rawEmail && !email) invalid.push("email")
  const found = new Map<string, CrmCustomer>()
  for (const c of phone ? crm.byPhone[phone] ?? [] : []) found.set(c.id, c)
  for (const c of email ? crm.byEmail[email] ?? [] : []) found.set(c.id, c)
  const list = [...found.values()]
  if (list.length === 0) return { res: { kind: "none" }, phone, email, invalid }
  if (list.length === 1) return { res: { kind: "one", customer: list[0] }, phone, email, invalid }
  return { res: { kind: "many", candidates: list }, phone, email, invalid }
}

type Planned = { proposal: PlannedProposal; customer?: CrmCustomer }

function planCustomer(b: Built, ctx: PlanContext): Planned {
  const { res, phone, email, invalid } = resolveHeard(b, ctx.crm)
  const name = val(b, "name")
  const bad = ungrounded(b)
  if (bad.length) return { proposal: review(b, "unsupported_value", { ambiguity: { ungrounded_fields: bad } }) }
  if (invalid.length) return { proposal: review(b, "unsupported_value", { ambiguity: { invalid_fields: invalid } }) }
  if (!phone && !email) {
    const candidates = name ? ctx.crm.byName[nameKey(name)] ?? [] : []
    return {
      proposal: review(b, "identity_unverified", {
        ambiguity: { candidate_customer_ids: candidates.map((c) => c.id), note: "A name alone never links or creates a customer." },
      }),
    }
  }
  if (lowConfidence(b)) return { proposal: review(b, "low_confidence") }
  if (res.kind === "many") {
    return { proposal: review(b, "ambiguous_identity", { ambiguity: { candidate_customer_ids: res.candidates.map((c) => c.id) } }) }
  }
  if (res.kind === "one") {
    const c = res.customer
    const conflicts: Record<string, { crm: string; heard: string }> = {}
    if (name && c.name && norm(name) !== norm(c.name)) conflicts.name = { crm: c.name, heard: name }
    if (phone && c.phoneCanonical && phone !== c.phoneCanonical) conflicts.phone = { crm: c.phoneCanonical, heard: phone }
    if (email && c.emailCanonical && email !== c.emailCanonical) conflicts.email = { crm: c.emailCanonical, heard: email }
    if (Object.keys(conflicts).length) {
      // The identifier matched but a heard value disagrees with the CRM, so WHO this caller is has not been
      // established: nothing else is proposed against this customer until a human resolves it.
      return { proposal: review(b, "conflicting_crm_value", { ambiguity: { conflicts }, customerId: c.id }) }
    }
    const nothingNew = (!name || !!c.name) && (!phone || !!c.phoneCanonical) && (!email || !!c.emailCanonical)
    if (nothingNew) return { proposal: { ...review(b, "no_new_information", { customerId: c.id }) }, customer: c }
  }
  const payload = { name: name ?? null, phone, email }
  const parsed = recordCommandSchema.safeParse({ type: "resolve_customer", payload })
  if (!parsed.success) return { proposal: review(b, "unsupported_value", { ambiguity: { invalid_payload: true } }) }
  return {
    proposal: staged(b, "resolve_customer", payload, { customerId: res.kind === "one" ? res.customer.id : undefined, bind: res.kind === "one" ? ["name", "phone", "email"] : undefined }),
    customer: res.kind === "one" ? res.customer : undefined,
  }
}

// ---------------------------------------------------------------------------
// vehicle
// ---------------------------------------------------------------------------
type VehicleFields = { make?: string; model?: string; year?: number; color?: string }
const sameVehicleField = (heard: string | number | undefined, have: string | number | null): boolean =>
  heard === undefined || have === null || norm(String(heard)) === norm(String(have))

function planVehicle(b: Built, customer: CrmCustomer | undefined, ctx: PlanContext): PlannedProposal | "skip" {
  if (!customer) return review(b, "customer_unresolved")
  const bad = ungrounded(b)
  if (bad.length) return review(b, "unsupported_value", { ambiguity: { ungrounded_fields: bad }, customerId: customer.id })
  if (lowConfidence(b)) return review(b, "low_confidence", { customerId: customer.id })
  const heard: VehicleFields = {
    make: val(b, "make"), model: val(b, "model"), year: val<number>(b, "year"), color: val(b, "color"),
  }
  const owned: CrmVehicle[] = ctx.crm.vehiclesByCustomer[customer.id] ?? []
  const before = { name: customer.name, phone: customer.phone, email: customer.email }
  const base = { customer_id: customer.id, before, expected_updated_at: customer.updatedAt, changes: {} as Record<string, never> }
  const build = (vehicle: Record<string, unknown>, vehicleId?: string): PlannedProposal => {
    const payload = { ...base, vehicle }
    const parsed = recordCommandSchema.safeParse({ type: "update_customer", payload })
    if (!parsed.success) return review(b, "unsupported_value", { ambiguity: { invalid_payload: true }, customerId: customer.id })
    return staged(b, "update_customer", payload, { customerId: customer.id, vehicleId })
  }
  const only = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

  if (owned.length === 0) {
    if (!heard.make) return review(b, "vehicle_incomplete", { customerId: customer.id })
    return build({ before: null, id: null, expected_updated_at: null, changes: only(heard) })
  }
  const compatible = owned.filter(
    (v) => sameVehicleField(heard.make, v.make) && sameVehicleField(heard.model, v.model)
      && sameVehicleField(heard.year, v.year) && sameVehicleField(heard.color, v.color),
  )
  if (compatible.length === 0) {
    return review(b, owned.length === 1 ? "conflicting_crm_value" : "second_vehicle_needs_review", {
      customerId: customer.id,
      ambiguity: { existing_vehicle_ids: owned.map((v) => v.id), heard: only(heard) },
    })
  }
  if (compatible.length > 1) {
    return review(b, "ambiguous_vehicle", { customerId: customer.id, ambiguity: { candidate_vehicle_ids: compatible.map((v) => v.id) } })
  }
  const v = compatible[0]
  const fill = only({
    make: v.make === null ? heard.make : undefined,
    model: v.model === null ? heard.model : undefined,
    year: v.year === null ? heard.year : undefined,
    color: v.color === null ? heard.color : undefined,
  })
  if (Object.keys(fill).length === 0) return "skip"
  return build(
    { before: { make: v.make, model: v.model, year: v.year, color: v.color }, id: v.id, expected_updated_at: v.updatedAt, changes: fill },
    v.id,
  )
}

// ---------------------------------------------------------------------------
// notes (service request, timing)
// ---------------------------------------------------------------------------
const NOTE_LABELS: Record<string, string> = {
  service: "Requested service",
  condition: "Vehicle condition",
  location: "Service location",
  preferred_timing: "Preferred timing",
  constraints: "Constraints",
}

function planNote(b: Built, customer: CrmCustomer | undefined, ctx: PlanContext): PlannedProposal {
  if (!customer) return review(b, "customer_unresolved")
  if (lowConfidence(b)) return review(b, "low_confidence", { customerId: customer.id })
  const lines = b.fields.map((f) => `- ${NOTE_LABELS[f.name] ?? f.name}: ${String(f.value)}`)
  const content = [`Call note (call evidence revision ${ctx.evidence.revision}, unverified until reviewed):`, ...lines].join("\n").slice(0, 2000)
  const payload = {
    customer_id: customer.id,
    channel: "note",
    role: "system",
    content,
    metadata: { origin: "call_copilot", kind: b.p.kind, call_id: ctx.callId, evidence_revision_id: ctx.evidence.revisionId, evidence_revision: ctx.evidence.revision },
  }
  const parsed = recordCommandSchema.safeParse({ type: "record_interaction", payload })
  if (!parsed.success) return review(b, "unsupported_value", { ambiguity: { invalid_payload: true }, customerId: customer.id })
  return staged(b, "record_interaction", payload, { customerId: customer.id })
}

// ---------------------------------------------------------------------------
// quote, appointment, message
// ---------------------------------------------------------------------------
const quotePayload = z
  .object({
    customer_name: z.string().trim().min(1).max(200),
    phone: z.string().refine((v) => normalizeDestination("sms", v) === v),
    car_info: z.string().max(200).nullable(),
    services: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
    notes: z.string().max(500).nullable(),
  })
  .strict()

const carInfo = (vehicles: CrmVehicle[]): string | null => {
  if (vehicles.length !== 1) return null
  const v = vehicles[0]
  const s = [v.year, v.make, v.model].filter((x) => x !== null && x !== undefined).join(" ")
  return s || null
}

function planQuote(b: Built, customer: CrmCustomer | undefined, ctx: PlanContext): PlannedProposal {
  if (!customer) return review(b, "customer_unresolved")
  const bad = ungrounded(b)
  if (bad.length) return review(b, "unsupported_value", { ambiguity: { ungrounded_fields: bad }, customerId: customer.id })
  if (lowConfidence(b)) return review(b, "low_confidence", { customerId: customer.id })
  if (!customer.phoneCanonical) return review(b, "no_verified_phone", { customerId: customer.id })
  if (!customer.name) return review(b, "customer_name_missing", { customerId: customer.id })
  // Prices are never taken from the call: the existing quote executor prices a DRAFT from the shop menu at approval.
  const payload = {
    customer_name: customer.name,
    phone: customer.phoneCanonical,
    car_info: carInfo(ctx.crm.vehiclesByCustomer[customer.id] ?? []),
    services: val<string[]>(b, "services") ?? [],
    notes: val(b, "notes") ?? null,
  }
  if (!quotePayload.safeParse(payload).success) return review(b, "unsupported_value", { ambiguity: { invalid_payload: true }, customerId: customer.id })
  return staged(b, "create_quote", payload, { customerId: customer.id, bind: ["name", "phone"] })
}

const mcp = <T extends "send_sms" | "book_appointment">(type: T) => mcpProposalSchemas.find((s) => s.shape.type.value === type)!

function planAppointment(b: Built, customer: CrmCustomer | undefined, ctx: PlanContext): PlannedProposal {
  if (!customer) return review(b, "customer_unresolved")
  if (b.fields.some((f) => f.confidence !== "high")) return review(b, "needs_high_confidence", { customerId: customer.id })
  const start = val(b, "start")
  const duration = val<number>(b, "duration_minutes")
  if (!start || Date.parse(start) <= ctx.now.getTime()) return review(b, "start_unusable", { customerId: customer.id })
  // A well-formed future timestamp with a citation is NOT enough: the cited words must literally say that date and time in
  // the shop's timezone, unhedged and unambiguous. Anything less stays a review-only proposal for a person to confirm.
  const utterances = (name: string): string[] => {
    const f = b.fields.find((x) => x.name === name)
    return [...new Set((f?.citations ?? []).map((c) => ctx.segments.get(c.segment_index)?.text ?? ""))].filter(Boolean)
  }
  const startCheck = groundStart({
    iso: start, spanText: b.cited.get("start") ?? "", utteranceTexts: utterances("start"), timezone: ctx.timezone, now: ctx.now,
  })
  if (!startCheck.ok) return review(b, startCheck.reason, { customerId: customer.id })
  // Availability is NEVER assumed: the booking executor re-checks it at approval. A duration is never guessed.
  if (!duration) return review(b, "duration_unconfirmed", { customerId: customer.id })
  const durationCheck = groundDuration({ minutes: duration, spanText: b.cited.get("duration_minutes") ?? "", utteranceTexts: utterances("duration_minutes") })
  if (!durationCheck.ok) return review(b, durationCheck.reason, { customerId: customer.id })
  if (!customer.phoneCanonical) return review(b, "no_verified_phone", { customerId: customer.id })
  if (!customer.name) return review(b, "customer_name_missing", { customerId: customer.id })
  const payload = {
    customer_id: customer.id,
    customer_name: customer.name,
    phone: customer.phoneCanonical,
    email: customer.emailCanonical,
    car_info: carInfo(ctx.crm.vehiclesByCustomer[customer.id] ?? []),
    service: val(b, "service") ?? null,
    iso_start_time: start,
    duration_minutes: duration,
    timezone: null,
    pin_notes: val(b, "notes") ?? null,
  }
  if (!mcp("book_appointment").safeParse({ type: "book_appointment", payload }).success) {
    return review(b, "unsupported_value", { ambiguity: { invalid_payload: true }, customerId: customer.id })
  }
  return staged(b, "book_appointment", payload, { customerId: customer.id, bind: ["name", "phone", "email"] })
}

function planMessage(b: Built, customer: CrmCustomer | undefined): PlannedProposal {
  if (!customer) return review(b, "customer_unresolved")
  if (lowConfidence(b)) return review(b, "low_confidence", { customerId: customer.id })
  const body = val(b, "body") ?? ""
  // Customer-facing words are drafted from untrusted speech: no links, no contact details, no sensitive data.
  if (hasLinkOrContact(body) || containsSensitive(body) || looksLikeInstruction(body)) {
    return review(b, "message_content_unsafe", { customerId: customer.id })
  }
  if (!customer.phoneCanonical) return review(b, "no_verified_phone", { customerId: customer.id })
  const payload = {
    customer_id: customer.id,
    customer_name: customer.name,
    to_phone: customer.phoneCanonical,
    body,
    // The strictest category: it needs the destination's own consent at send time. A call is never a proof.
    category: "marketing" as const,
    reason: "Drafted from a consented call; needs your approval",
  }
  if (!mcp("send_sms").safeParse({ type: "send_sms", payload }).success) {
    return review(b, "unsupported_value", { ambiguity: { invalid_payload: true }, customerId: customer.id })
  }
  return staged(b, "send_sms", payload, { customerId: customer.id, bind: ["name", "phone"] })
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
export function planProposals(output: ExtractorOutput, ctx: PlanContext): PlanResult {
  const planned: PlannedProposal[] = []
  const refused: PlanResult["refused"] = []
  const skipped: PlanResult["skipped"] = []
  const prepared: Built[] = []
  for (const p of output.proposals) {
    const r = prepare(p, ctx)
    if (r.ok) prepared.push(r.built)
    else refused.push(r.refusal)
  }

  // 1. customers first: they decide whom the other proposals are about.
  const customers = prepared.filter((b) => b.p.kind === "customer")
  const customerPlans = new Map<Built, Planned>()
  for (const b of customers) customerPlans.set(b, planCustomer(b, ctx))
  const linked = new Map<string, CrmCustomer>()
  for (const pl of customerPlans.values()) if (pl.customer) linked.set(pl.customer.id, pl.customer)

  let callCustomer: CrmCustomer | undefined
  let identityConflict = false
  if (ctx.crm.known) {
    callCustomer = ctx.crm.known
    if ([...linked.keys()].some((id) => id !== ctx.crm.known!.id)) {
      identityConflict = true
      callCustomer = undefined
    }
  } else if (linked.size === 1) {
    callCustomer = [...linked.values()][0]
  } else if (linked.size > 1) {
    identityConflict = true
  }

  for (const b of prepared) {
    if (b.p.kind === "customer") {
      const pl = customerPlans.get(b)!.proposal
      if (pl.review_reason === "no_new_information") skipped.push({ kind: "customer", reason: "no_new_information" })
      else planned.push(pl)
      continue
    }
    const who = identityConflict ? undefined : callCustomer
    const withReason = (pl: PlannedProposal): PlannedProposal =>
      identityConflict && pl.review_reason === "customer_unresolved" ? { ...pl, review_reason: "identity_conflict" } : pl
    switch (b.p.kind) {
      case "vehicle": {
        const pl = planVehicle(b, who, ctx)
        if (pl === "skip") skipped.push({ kind: "vehicle", reason: "no_new_information" })
        else planned.push(withReason(pl))
        break
      }
      case "service_request":
      case "timing":
        planned.push(withReason(planNote(b, who, ctx)))
        break
      case "quote_draft":
        planned.push(withReason(planQuote(b, who, ctx)))
        break
      case "appointment_draft":
        planned.push(withReason(planAppointment(b, who, ctx)))
        break
      case "message_draft":
        planned.push(withReason(planMessage(b, who)))
        break
      case "lead":
        // Source, stage, owner and next action have no guarded executor: a human sets them from the review.
        planned.push(review(b, "no_guarded_executor", who ? { customerId: who.id } : {}))
        break
      case "followup_task":
        planned.push(review(b, "no_guarded_executor", who ? { customerId: who.id } : {}))
        break
      case "memory_candidate": {
        // Customer scope only, and REVIEW-ONLY for good: the reviewed-memory store and its retrieval are shop-wide, so no path
        // from here into it exists until customer-scoped publication AND retrieval do. The database refuses to stage one.
        const bad = ungrounded(b)
        if (!who) planned.push(withReason(review(b, "customer_unresolved")))
        else if (lowConfidence(b) || bad.length) planned.push(review(b, lowConfidence(b) ? "low_confidence" : "unsupported_value", { customerId: who.id }))
        else planned.push(review(b, "customer_memory_review_only", { customerId: who.id }))
        break
      }
    }
  }
  return { planned, refused, skipped }
}
