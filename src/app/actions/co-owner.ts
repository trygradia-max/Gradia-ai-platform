"use server"

import { revalidatePath } from "next/cache"

import { requireShop, requireUser } from "@/lib/shop"
import { sendSmsApprovalRequest } from "@/lib/slack"
import { draftCustomSmsForCustomer } from "@/lib/sms-drafter"
import { createClient } from "@/lib/supabase/server"
import type { LeadRow, ShopRow } from "@/lib/types/database"

export type DraftFollowupResult =
  | { ok: true; pendingId: string }
  | { ok: false; error: string }

/**
 * One-click follow-up from the co-owner widget. Loads the lead,
 * runs the SMS drafter with a "gentle check-in" intent, and stages
 * a send_sms pending action for HITL approval. Mirrors the existing
 * `proposeOutboundSms` flow but adds the drafter call so the
 * operator never has to write the message themselves.
 */
export async function draftFollowupForLead(
  leadId: string
): Promise<DraftFollowupResult> {
  await requireUser()
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data: leadRow, error: leadErr } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("shop_id", shopCtx.id)
    .maybeSingle()
  if (leadErr) return { ok: false, error: leadErr.message }
  const lead = (leadRow as LeadRow | null) ?? null
  if (!lead) return { ok: false, error: "Lead not found." }
  if (!lead.phone?.trim()) {
    return {
      ok: false,
      error: "No phone on file — can't follow up via SMS.",
    }
  }

  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (shopRow as ShopRow | null) ?? null
  if (!shop?.twilio_phone_number) {
    return {
      ok: false,
      error: "Connect a Twilio number in /settings before drafting SMS.",
    }
  }

  const draft = await draftCustomSmsForCustomer({
    shopName: shop.name,
    customerName: lead.customer_name,
    vehicle: lead.car_info,
    service: lead.pin_notes,
    intent:
      "Gentle follow-up — we haven't heard back in a few days. One short check-in to see if they're still interested. No pressure.",
  }).catch((err) => {
    console.error("[co-owner] drafter failed:", err)
    return null
  })
  if (!draft) {
    return { ok: false, error: "Drafter didn't produce a message." }
  }

  const reason = `Co-owner suggestion · follow up on ${lead.customer_name}`
  const payload = {
    to_phone: lead.phone,
    body: draft,
    customer_name: lead.customer_name,
    customer_id: lead.customer_id,
    reason,
    source: "co_owner_followup",
    lead_id: lead.id,
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shopCtx.id,
      action_type: "send_sms",
      payload,
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    return {
      ok: false,
      error: pendingErr?.message ?? "Couldn't stage the draft.",
    }
  }

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: lead.phone,
      customerName: lead.customer_name,
      body: draft,
      reason,
    })
  } catch (err) {
    console.error("[co-owner] Slack approval send failed:", err)
  }

  revalidatePath("/approvals")
  revalidatePath("/dashboard")
  return { ok: true, pendingId: pending.id }
}
