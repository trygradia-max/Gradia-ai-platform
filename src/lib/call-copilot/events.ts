import { z } from "zod"

/**
 * Call Copilot ingress vocabulary (PR D).
 *
 * Human-first INBOUND calls only: the operator answers and conducts the call;
 * Gradia is a disclosed, silent copilot. Every event below is CONTENT-FREE
 * evidence about disclosure, consent and capture state. There is deliberately
 * no field that can carry audio, transcript or speech text, a phone number, a
 * name or a free-text note, and every schema is strict, so a provider payload
 * that tries to add one is rejected rather than stored.
 *
 * The disclosure version is an opaque reference. No disclosure wording is
 * stored or approved by this module; wording and jurisdiction handling need
 * counsel approval before any pilot use.
 */

export const CALL_COPILOT_PROVIDERS = ["twilio"] as const
export type CallCopilotProvider = (typeof CALL_COPILOT_PROVIDERS)[number]

/** Only Gradia-controlled paths. A call that bypasses Gradia cannot produce events. */
export const CALL_COPILOT_ROUTE_KINDS = ["gradia_controlled_number", "approved_forwarding_bridge"] as const
export type CallCopilotRouteKind = (typeof CALL_COPILOT_ROUTE_KINDS)[number]

/** All-party consent: exactly these two parties, both required. */
export const CALL_COPILOT_PARTIES = ["operator", "caller"] as const
export type CallCopilotParty = (typeof CALL_COPILOT_PARTIES)[number]

/** Live capture purposes (audio exists only while capture is active). */
export const CALL_COPILOT_LIVE_PURPOSES = ["recording", "transcription"] as const
/** Work on already-captured content. Each still needs intact consent evidence. */
export const CALL_COPILOT_DERIVED_PURPOSES = ["model_use", "summarization", "extraction", "crm_mutation"] as const
export const CALL_COPILOT_CAPTURE_PURPOSES = [...CALL_COPILOT_LIVE_PURPOSES, ...CALL_COPILOT_DERIVED_PURPOSES] as const
export type CallCopilotCapturePurpose = (typeof CALL_COPILOT_CAPTURE_PURPOSES)[number]

const providerCallId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const providerEventId = z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/)
/** Logical order assigned by the Gradia-controlled path; arrival order never matters. */
const sequence = z.number().int().min(1).max(5000)
const occurredAt = z.string().datetime({ offset: true })
const disclosureVersion = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
const reasonCode = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)
const region = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)
const party = z.enum(CALL_COPILOT_PARTIES)

const common = { providerCallId, providerEventId, sequence, occurredAt }

export const callCopilotEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("call_opened"),
    routeKind: z.enum(CALL_COPILOT_ROUTE_KINDS),
    operatorRegion: region.optional(),
    callerRegion: region.optional(),
  }).strict(),
  z.object({
    ...common,
    kind: z.literal("disclosure_delivered"),
    party,
    disclosureVersion,
  }).strict(),
  z.object({
    ...common,
    kind: z.literal("consent_granted"),
    party,
    disclosureVersion,
    /** The disclosure_delivered sequence this response answers. */
    respondsToSequence: sequence,
  }).strict(),
  z.object({
    ...common,
    kind: z.literal("consent_declined"),
    party,
    disclosureVersion,
    respondsToSequence: sequence.optional(),
  }).strict(),
  z.object({ ...common, kind: z.literal("capture_paused"), reason: reasonCode.optional() }).strict(),
  z.object({ ...common, kind: z.literal("capture_resumed"), reason: reasonCode.optional() }).strict(),
  z.object({ ...common, kind: z.literal("capture_stopped"), reason: reasonCode.optional() }).strict(),
  z.object({ ...common, kind: z.literal("call_ended") }).strict(),
  z.object({ ...common, kind: z.literal("provider_outcome_unknown"), reason: reasonCode }).strict(),
  z.object({ ...common, kind: z.literal("participant_added"), reason: reasonCode.optional() }).strict(),
])

export type CallCopilotEvent = z.infer<typeof callCopilotEventSchema>
export type CallCopilotEventKind = CallCopilotEvent["kind"]

/** Parse untrusted provider-derived input. Never throws. */
export function parseCallCopilotEvent(input: unknown): CallCopilotEvent | null {
  const parsed = callCopilotEventSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}
