"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { requireShop, requireUser } from "@/lib/shop"
import { sendFacebookDmApprovalRequest } from "@/lib/slack"
import { createClient } from "@/lib/supabase/server"

const proposeSchema = z.object({
  recipient_id: z
    .string()
    .trim()
    .min(1, "Recipient ID is required.")
    .max(120),
  body: z.string().trim().min(1, "Message can't be empty.").max(900),
  customer_name: z.string().trim().max(200).nullable().optional(),
  customer_id: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(200).nullable().optional(),
})

export type ProposeFacebookDmResult =
  | { ok: true; pendingId: string }
  | { ok: false; error: string }

export async function proposeOutboundFacebookDm(
  input: z.infer<typeof proposeSchema>
): Promise<ProposeFacebookDmResult> {
  const parsed = proposeSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid FB DM proposal.",
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
    recipient_id: parsed.data.recipient_id,
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
      action_type: "send_facebook_dm",
      payload,
      requested_by: ownerId,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    return {
      ok: false,
      error: pendingErr?.message ?? "Couldn't queue the FB DM.",
    }
  }

  try {
    await sendFacebookDmApprovalRequest({
      pendingActionId: pending.id,
      recipientId: parsed.data.recipient_id,
      customerName: parsed.data.customer_name ?? null,
      body: parsed.data.body,
      reason: parsed.data.reason ?? null,
    })
  } catch (err) {
    console.error("[outbound-facebook] Slack approval send failed:", err)
  }

  revalidatePath("/approvals")
  return { ok: true, pendingId: pending.id }
}
