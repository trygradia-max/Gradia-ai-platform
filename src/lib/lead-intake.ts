import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

/**
 * Durable normalized intake. The shop id is an explicit argument and is
 * never taken from the payload. Contact fields are stored as supplied text.
 * The website-form acceptor checks that the bound shop row exists. It does
 * not look up a customer, infer consent, create a lead, or call a provider.
 */
const intakePayloadSchema = z.object({
  display_name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(4000).optional(),
  vehicle_text: z.string().trim().min(1).max(200).optional(),
  service_text: z.string().trim().min(1).max(200).optional(),
}).strict()

export const leadIntakeInputSchema = z.object({
  shopId: z.string().uuid(),
  channel: z.enum(["sms", "website_form", "meta", "synthetic"]),
  provider: z.string().trim().min(1).max(64),
  providerEventId: z.string().trim().min(1).max(512),
  receivedAt: z.string().datetime({ offset: true }),
  evidenceRef: z.string().trim().min(1).max(512).nullable().optional(),
  threadKey: z.string().trim().min(1).max(256).nullable().optional(),
  payload: intakePayloadSchema,
}).strict()

export type LeadIntakeInput = z.infer<typeof leadIntakeInputSchema>

const leadIntakeResultSchema = z.object({
  status: z.enum(["recorded", "already_recorded"]),
  envelope_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  transition_id: z.string().uuid(),
  revision: z.number().int().positive(),
  state: z.literal("identity_review"),
})

export type LeadIntakeResult = {
  status: "recorded" | "already_recorded"
  envelopeId: string
  workflowId: string
  transitionId: string
  revision: number
  state: "identity_review"
}

/**
 * Verified inbound SMS. The shop id is the number binding, and the
 * MessageSid is the provider event id. The sender address is stored as
 * text. It is not a thread key, a customer lookup, or a consent record.
 */
export function inboundSmsIntakeInput(input: {
  shopId: string
  messageSid: string
  from: string
  body: string
  receivedAt: string
}): LeadIntakeInput {
  const phone = input.from.trim()
  const message = input.body.trim()
  return {
    shopId: input.shopId,
    channel: "sms",
    provider: "twilio",
    providerEventId: input.messageSid.trim(),
    receivedAt: input.receivedAt,
    evidenceRef: null,
    threadKey: null,
    payload: {
      ...(phone ? { phone } : {}),
      ...(message ? { message } : {}),
    },
  }
}

export async function recordLeadIntake(
  db: SupabaseClient,
  input: LeadIntakeInput,
): Promise<LeadIntakeResult> {
  const parsed = leadIntakeInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error("Intake record rejected. Shop, event, and payload must be explicit.")
  }
  const { data, error } = await db.rpc("record_lead_intake", {
    p_shop: parsed.data.shopId,
    p_channel: parsed.data.channel,
    p_provider: parsed.data.provider,
    p_event_id: parsed.data.providerEventId,
    p_received_at: parsed.data.receivedAt,
    p_evidence_ref: parsed.data.evidenceRef ?? null,
    p_thread_key: parsed.data.threadKey ?? null,
    p_payload: parsed.data.payload,
  })
  if (error) {
    throw new Error(`Intake record failed: ${error.message}`)
  }
  const body = typeof data === "string" ? JSON.parse(data) : data
  const result = leadIntakeResultSchema.safeParse(body)
  if (!result.success) {
    throw new Error("Intake record failed: the saved result could not be read.")
  }
  return {
    status: result.data.status,
    envelopeId: result.data.envelope_id,
    workflowId: result.data.workflow_id,
    transitionId: result.data.transition_id,
    revision: result.data.revision,
    state: result.data.state,
  }
}

/** Distinct from Twilio. There is no earlier website-form provider name. */
export const WEBSITE_FORM_PROVIDER = "website_form"

const websiteFormText = z.string().trim().min(1).max(200)
const websiteFormMessage = z.string().trim().min(1).max(4000)

export const websiteFormSubmissionSchema = z.object({
  submission_id: z.string().trim().min(1).max(512),
  thread_key: z.string().trim().min(1).max(256).optional(),
  shop_id: z.string().uuid().optional(),
  display_name: websiteFormText.optional(),
  phone: websiteFormText.optional(),
  email: websiteFormText.optional(),
  message: websiteFormMessage.optional(),
  vehicle_text: websiteFormText.optional(),
  service_text: websiteFormText.optional(),
}).strict()

const WEBSITE_FORM_FIELDS = [
  "display_name",
  "phone",
  "email",
  "message",
  "vehicle_text",
  "service_text",
] as const

export type WebsiteFormSubmission = {
  submissionId: string
  threadKey: string | null
  claimedShopId: string | null
  payload: z.infer<typeof intakePayloadSchema>
}

/**
 * Drops blank optional strings. Unknown keys stay so the strict schema
 * can refuse them. The submission id is required even when blank.
 */
export function normalizeWebsiteFormBody(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      next[key] = value
      continue
    }
    const trimmed = value.trim()
    if (trimmed === "" && key !== "submission_id") continue
    next[key] = trimmed
  }
  return next
}

export function readWebsiteFormSubmission(body: unknown): WebsiteFormSubmission | null {
  const parsed = websiteFormSubmissionSchema.safeParse(normalizeWebsiteFormBody(body))
  if (!parsed.success) return null
  const payload: WebsiteFormSubmission["payload"] = {}
  for (const key of WEBSITE_FORM_FIELDS) {
    const value = parsed.data[key]
    if (value) payload[key] = value
  }
  return {
    submissionId: parsed.data.submission_id,
    threadKey: parsed.data.thread_key ?? null,
    claimedShopId: parsed.data.shop_id ?? null,
    payload,
  }
}

/**
 * Website form evidence. The shop id is the server binding. Phone, email,
 * and name stay in the payload. They are not a thread key.
 */
export function websiteFormIntakeInput(input: {
  shopId: string
  submissionId: string
  receivedAt: string
  threadKey?: string | null
  payload: z.infer<typeof intakePayloadSchema>
}): LeadIntakeInput {
  const thread = input.threadKey?.trim()
  return {
    shopId: input.shopId,
    channel: "website_form",
    provider: WEBSITE_FORM_PROVIDER,
    providerEventId: input.submissionId.trim(),
    receivedAt: input.receivedAt,
    evidenceRef: null,
    threadKey: thread ? thread : null,
    payload: input.payload,
  }
}

export type WebsiteFormIntakeAcceptance =
  | { ok: true; result: LeadIntakeResult }
  | { ok: false; status: 400 | 403; error: string }

function sameShopId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/**
 * One record_lead_intake call for a submission the server has already
 * bound to a shop. A body shop id is a claim, not the tenant. A missing
 * shop row, a foreign claim, or an event already stored for another shop
 * returns without a new envelope.
 */
export async function acceptWebsiteFormIntake(
  db: SupabaseClient,
  boundShopId: string,
  body: unknown,
  receivedAt: string,
): Promise<WebsiteFormIntakeAcceptance> {
  if (!z.string().uuid().safeParse(boundShopId).success) {
    return { ok: false, status: 403, error: "Set up your shop first." }
  }
  const submission = readWebsiteFormSubmission(body)
  if (!submission) {
    return { ok: false, status: 400, error: "Check the submission and try again." }
  }
  if (submission.claimedShopId && !sameShopId(submission.claimedShopId, boundShopId)) {
    return { ok: false, status: 403, error: "Shop binding does not match." }
  }
  const shop = await db.from("shops").select("id").eq("id", boundShopId).maybeSingle()
  if (shop.error) {
    throw new Error("Intake shop lookup failed")
  }
  if (!shop.data) {
    return { ok: false, status: 403, error: "Set up your shop first." }
  }
  try {
    const result = await recordLeadIntake(
      db,
      websiteFormIntakeInput({
        shopId: boundShopId,
        submissionId: submission.submissionId,
        receivedAt,
        threadKey: submission.threadKey,
        payload: submission.payload,
      }),
    )
    return { ok: true, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : ""
    if (message.includes("another shop") || message.includes("unavailable")) {
      return { ok: false, status: 403, error: "Shop binding does not match." }
    }
    throw err
  }
}
