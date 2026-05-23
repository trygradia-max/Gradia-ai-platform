"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { findCustomerByChannel, normalizePhone } from "@/lib/customers"
import { recordInteraction } from "@/lib/memory"
import { requireShop, requireUser } from "@/lib/shop"
import { sendSmsApprovalRequest } from "@/lib/slack"
import { createClient } from "@/lib/supabase/server"
import {
  defaultStatusCallbackUrl,
  resolveTwilioCredentials,
  sendOutboundSms,
} from "@/lib/twilio"
import type { ShopRow } from "@/lib/types/database"

const PHONE_PATTERN = /^\+\d{8,15}$/

const proposeSchema = z.object({
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

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: parsed.data.to_phone,
      customerName: parsed.data.customer_name ?? null,
      body: parsed.data.body,
      reason: parsed.data.reason ?? null,
    })
  } catch (err) {
    console.error("[outbound-sms] Slack approval send failed:", err)
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

  let sendResult
  try {
    sendResult = await sendOutboundSms({
      from: shop.twilio_phone_number,
      to: parsed.data.to_phone,
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

  const normalizedTo = normalizePhone(parsed.data.to_phone) ?? parsed.data.to_phone
  const customer = await findCustomerByChannel(supabase, shop.id, {
    phone: normalizedTo,
  })

  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId: customer?.id ?? null,
    channel: "sms",
    role: "gradia",
    content: parsed.data.body,
    metadata: {
      direction: "outbound",
      sent_by: "operator",
      twilio_message_sid: sendResult.messageSid,
      twilio_status: sendResult.status,
      to_phone: normalizedTo,
      from_phone: shop.twilio_phone_number,
    },
  })

  revalidatePath("/approvals")
  revalidatePath("/dashboard")
  return { ok: true, messageSid: sendResult.messageSid }
}
