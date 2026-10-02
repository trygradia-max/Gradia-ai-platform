import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

/**
 * Durable normalized intake. The shop id is an explicit argument and is
 * never taken from the payload. Contact fields are stored as supplied text.
 * This module does not look up a customer, infer consent, create a lead,
 * or call a provider.
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
