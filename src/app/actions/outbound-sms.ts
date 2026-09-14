"use server"

import { servicePayload, claimServiceExecution, completeServiceExecution } from "@/lib/service-purpose"
import { evaluateSmsSendPolicy } from "@/lib/send-policy"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { recordInteraction } from "@/lib/memory"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { smsGateForShop } from "@/lib/telephony-provider"
import {
  defaultStatusCallbackUrl,
  resolveTwilioCredentials,
  sendOutboundSms,
} from "@/lib/twilio"
import type { ShopRow } from "@/lib/types/database"

const PHONE_PATTERN = /^\+\d{8,15}$/

const proposeSchema = z.object({
  category: z.enum(["transactional", "marketing"]).default("marketing"),
  to_phone: z
    .string()
    .trim()
    .refine((v) => PHONE_PATTERN.test(v), "Recipient must be in E.164 format."),
  body: z.string().trim().min(1, "Message can't be empty.").max(1600),
  customer_name: z.string().trim().max(200).nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(200).nullable().optional(),
})

export type ProposeSmsResult =
  | { ok: true; pendingId: string }
  | { ok: false; error: string }

/**
 * Stages an AI-initiated outbound SMS for human approval. Cron jobs,
 * agent triggers, and webhooks call this — never a button a human
 * directly clicked (use sendOperatorSms for those).
 */
export async function proposeOutboundSms(
  input: z.infer<typeof proposeSchema>
): Promise<ProposeSmsResult> {
  const parsed = proposeSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid SMS proposal.",
    }
  }

  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: ownerRow } = await supabase
    .from("shops")
    .select("owner_id")
    .eq("id", shop.id)
    .single()
  const ownerId = (ownerRow as { owner_id: string } | null)?.owner_id
  if (!ownerId) return { ok: false, error: "Shop owner not found." }

  const payload = {
    category: "marketing",
    to_phone: parsed.data.to_phone,
    body: parsed.data.body,
    customer_name: parsed.data.customer_name ?? null,
    customer_id: parsed.data.customer_id ?? null,
    reason: parsed.data.reason ?? null,
    source: "operator_propose",
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "send_sms",
      payload,
      requested_by: ownerId,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    return { ok: false, error: pendingErr?.message ?? "Couldn't queue SMS." }
  }

  revalidatePath("/approvals")
  return { ok: true, pendingId: pending.id }
}

const operatorSendSchema = z.object({
  to_phone: z
    .string()
    .trim()
    .refine((v) => PHONE_PATTERN.test(v), "Recipient must be in E.164 format."),
  body: z.string().trim().min(1, "Message can't be empty.").max(1600),
})

export type OperatorSendResult =
  | { ok: true; messageSid: string }
  | { ok: false; error: string }

/**
 * Sends an SMS directly from a logged-in operator — no HITL gate since
 * the operator is the human. Records the message as an outbound
 * interaction so memory + the customer thread stay coherent.
 */
export async function sendOperatorSms(
  input: z.infer<typeof operatorSendSchema>
): Promise<OperatorSendResult> {
  const parsed = operatorSendSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid SMS input.",
    }
  }

  await requireUser()
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (shopRow as ShopRow | null) ?? null

  if (!shop?.twilio_phone_number) {
    return {
      ok: false,
      error: "Connect a Twilio number in /settings first.",
    }
  }

  // A2P gate — Gradia-provisioned numbers can't text until carrier approval.
  const smsGate = smsGateForShop(shop, shop.twilio_phone_number)
  if (!smsGate.allowed) {
    return { ok: false, error: smsGate.reason }
  }

  const context = await servicePayload(supabase,shop.id,{to_phone:parsed.data.to_phone,body:parsed.data.body,source:"verified_reply"})
  const policy = await evaluateSmsSendPolicy(supabase, shop, {
    toPhone: parsed.data.to_phone, customerId: context.customer_id as string ?? null, category: context.service_proof ? "transactional" : "marketing", body:parsed.data.body, serviceProof:context.service_proof as string|null,
  })
  if (!policy.allowed) return { ok: false, error: policy.reason }

  const execution = context.service_proof ? await claimServiceExecution(supabase,{shopId:shop.id,customerId:policy.customerId,channel:"sms",destination:policy.destination,body:parsed.data.body},context.service_proof,false) : null
  if (execution && !execution.ok) return {ok:false,error:execution.reason}

  let sendResult
  try {
    sendResult = await sendOutboundSms({
      from: shop.twilio_phone_number,
      to: policy.destination,
      body: parsed.data.body,
      statusCallback: defaultStatusCallbackUrl(shop.id),
      creds: resolveTwilioCredentials(shop),
    })
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Twilio: ${err.message}`
          : "Twilio send failed.",
    }
  }

  await completeServiceExecution(supabase, shop.id, execution)
  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId: policy.customerId,
    channel: "sms",
    role: "gradia",
    content: parsed.data.body,
    metadata: {
      direction: "outbound",
      sent_by: "operator",
      twilio_message_sid: sendResult.messageSid,
      twilio_status: sendResult.status,
      to_phone: policy.destination,
      from_phone: shop.twilio_phone_number,
    },
  })

  revalidatePath("/approvals")
  revalidatePath("/dashboard")
  return { ok: true, messageSid: sendResult.messageSid }
}
