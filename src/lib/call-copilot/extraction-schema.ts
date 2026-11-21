import { z } from "zod"

/**
 * Call Copilot extraction contract (PR E).
 *
 * The extractor is a Gradia-owned seam (see extractor.ts). Everything it returns is UNTRUSTED
 * input validated against the strict schemas below. The closed vocabulary is the founder-approved
 * proposal list (docs/product/WHISPER_CALL_COPILOT.md): there is no field that can carry a tenant,
 * an action type, a policy, a tool name, a permission, an autonomy level or a price. Gradia code
 * (planner.ts) alone decides what a proposal may become.
 *
 * Every field carries qualitative confidence and exact transcript-span citations. Spans are
 * expressed as Unicode code-point offsets into one stored segment (end exclusive), and the database
 * re-verifies each one against the stored transcript.
 */

export const EXTRACTION_SCHEMA_VERSION = 1

export const CONFIDENCES = ["low", "medium", "high"] as const
export type Confidence = (typeof CONFIDENCES)[number]
export const confidenceRank = (c: Confidence): number => CONFIDENCES.indexOf(c)

export const citationSchema = z
  .object({
    segmentIndex: z.number().int().min(0).max(4999),
    start: z.number().int().min(0).max(2000),
    end: z.number().int().min(1).max(2000),
  })
  .strict()
  .refine((c) => c.end > c.start, "a citation span must be non-empty")
export type Citation = z.infer<typeof citationSchema>

const citations = z.array(citationSchema).min(1).max(5)
const confidence = z.enum(CONFIDENCES)

function field<T extends z.ZodType>(value: T) {
  return z.object({ value, confidence, citations }).strict()
}

const text = (max: number) => z.string().trim().min(1).max(max)

/** A phone number or e-mail exactly as heard; Gradia canonicalises and verifies it. */
const heardPhone = text(40)
const heardEmail = text(120)

const customerProposal = z
  .object({
    kind: z.literal("customer"),
    name: field(text(120)).optional(),
    phone: field(heardPhone).optional(),
    email: field(heardEmail).optional(),
  })
  .strict()

const vehicleProposal = z
  .object({
    kind: z.literal("vehicle"),
    year: field(z.number().int().min(1886).max(2100)).optional(),
    make: field(text(60)).optional(),
    model: field(text(60)).optional(),
    color: field(text(40)).optional(),
  })
  .strict()

const serviceRequestProposal = z
  .object({
    kind: z.literal("service_request"),
    service: field(text(300)).optional(),
    condition: field(text(300)).optional(),
    location: field(text(300)).optional(),
  })
  .strict()

const timingProposal = z
  .object({
    kind: z.literal("timing"),
    preferredTiming: field(text(300)).optional(),
    constraints: field(text(300)).optional(),
  })
  .strict()

/** Lead source / stage / owner / next action. No guarded executor exists, so these stay review-only. */
export const LEAD_SOURCES = ["phone", "referral", "walk_in", "web", "social", "other"] as const
/** The existing pipeline stages (src/lib/pipeline.ts PIPELINE_STAGES). Kept literal so this module imports no CRM code. */
export const LEAD_STAGES = ["new", "needs_quote", "quote_sent", "follow_up", "booked", "lost"] as const
const leadProposal = z
  .object({
    kind: z.literal("lead"),
    source: field(z.enum(LEAD_SOURCES)).optional(),
    stage: field(z.enum(LEAD_STAGES)).optional(),
    /** A name or role as spoken. Never a member id: ownership is assigned by a human. */
    ownerHint: field(text(100)).optional(),
    nextAction: field(text(200)).optional(),
    nextActionAt: field(z.string().datetime({ offset: true })).optional(),
  })
  .strict()

const quoteDraftProposal = z
  .object({
    kind: z.literal("quote_draft"),
    /** Service names as heard. Prices are NEVER extracted: the menu prices the draft at approval. */
    services: field(z.array(text(80)).min(1).max(10)),
    notes: field(text(500)).optional(),
  })
  .strict()

const appointmentDraftProposal = z
  .object({
    kind: z.literal("appointment_draft"),
    start: field(z.string().datetime({ offset: true })),
    durationMinutes: field(z.number().int().min(15).max(1440)).optional(),
    service: field(text(200)).optional(),
    notes: field(text(500)).optional(),
  })
  .strict()

const followupTaskProposal = z
  .object({
    kind: z.literal("followup_task"),
    title: field(text(120)),
    dueAt: field(z.string().datetime({ offset: true })).optional(),
    detail: field(text(300)).optional(),
  })
  .strict()

const messageDraftProposal = z
  .object({
    kind: z.literal("message_draft"),
    channel: z.literal("sms"),
    body: field(text(600)),
  })
  .strict()

const memoryCandidateProposal = z
  .object({
    kind: z.literal("memory_candidate"),
    /** Customer scope only. A shop-wide rule is not a valid value and fails the whole output. */
    scope: z.literal("customer"),
    preference: field(text(300)),
  })
  .strict()

export const extractedProposalSchema = z.discriminatedUnion("kind", [
  customerProposal,
  vehicleProposal,
  serviceRequestProposal,
  timingProposal,
  leadProposal,
  quoteDraftProposal,
  appointmentDraftProposal,
  followupTaskProposal,
  messageDraftProposal,
  memoryCandidateProposal,
])
export type ExtractedProposal = z.infer<typeof extractedProposalSchema>
export type ProposalKind = ExtractedProposal["kind"]
export const PROPOSAL_KINDS = [
  "customer", "vehicle", "service_request", "timing", "lead", "quote_draft",
  "appointment_draft", "followup_task", "message_draft", "memory_candidate",
] as const satisfies readonly ProposalKind[]

export const extractorOutputSchema = z
  .object({ proposals: z.array(extractedProposalSchema).max(50) })
  .strict()
export type ExtractorOutput = z.infer<typeof extractorOutputSchema>

/** What a seam receives. Segment text is DATA; there is no field for instructions or tools. */
export type ExtractorSegment = {
  index: number
  speaker: "operator" | "caller" | "unknown"
  text: string
  startedAt: string
  endedAt: string
}
export type ExtractorInput = {
  schemaVersion: number
  coverage: { status: "complete" | "partial"; reasons: string[] }
  segments: ExtractorSegment[]
}
