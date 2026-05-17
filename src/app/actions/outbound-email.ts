"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireShop, requireUser } from "@/lib/shop"
import { sendEmailApprovalRequest } from "@/lib/slack"
import { createClient } from "@/lib/supabase/server"

const proposeSchema = z.object({
  to_email: z.string().trim().email("Recipient must be a valid email."),
  subject: z
    .string()
    .trim()
    .min(1, "Subject can't be empty.")
    .max(200),
  body: z.string().trim().min(1, "Body can't be empty.").max(8_000),
  customer_name: z.string().trim().max(200).nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(200).nullable().optional(),
})

export type ProposeEmailResult =
  | { ok: true; pendingId: string }
  | { ok: false; error: string }

/**
 * Stages an AI-initiated outbound email for human approval.
 * Mirrors proposeOutboundSms. Operator approves in Slack or via the
 * /approvals/[id] editor.
 */
export async function proposeOutboundEmail(
  input: z.infer<typeof proposeSchema>
): Promise<ProposeEmailResult> {
  const parsed = proposeSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid email proposal.",
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
    to_email: parsed.data.to_email,
    subject: parsed.data.subject,
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
      action_type: "send_email",
      payload,
      requested_by: ownerId,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    return {
      ok: false,
      error: pendingErr?.message ?? "Couldn't queue the email.",
    }
  }

  try {
    await sendEmailApprovalRequest({
      pendingActionId: pending.id,
      toEmail: parsed.data.to_email,
      customerName: parsed.data.customer_name ?? null,
      subject: parsed.data.subject,
      body: parsed.data.body,
      reason: parsed.data.reason ?? null,
    })
  } catch (err) {
    console.error("[outbound-email] Slack approval send failed:", err)
  }

  revalidatePath("/approvals")
  return { ok: true, pendingId: pending.id }
}
