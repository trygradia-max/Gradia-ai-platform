import { revalidatePath } from "next/cache"

import { findOrCreateCustomer } from "@/lib/customers"
import { createServiceClient } from "@/lib/supabase/service"
import {
  leadApprovedBlocks,
  leadEditRequestedBlocks,
  replaceOriginalMessage,
  verifySlackSignature,
} from "@/lib/slack"
import type { LeadStatus } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type SlackInteractionPayload = {
  type: string
  user: { id: string; username?: string }
  actions?: Array<{
    action_id: string
    value: string
  }>
  response_url: string
}

type LeadProposal = {
  customer_name: string
  phone: string
  car_info: string | null
  pin_notes: string | null
  status: LeadStatus
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const timestamp = request.headers.get("x-slack-request-timestamp")
  const signature = request.headers.get("x-slack-signature")

  if (!verifySlackSignature({ rawBody, timestamp, signature })) {
    return new Response("Invalid signature", { status: 401 })
  }

  const params = new URLSearchParams(rawBody)
  const payloadRaw = params.get("payload")
  if (!payloadRaw) {
    return new Response("Missing payload", { status: 400 })
  }

  let payload: SlackInteractionPayload
  try {
    payload = JSON.parse(payloadRaw) as SlackInteractionPayload
  } catch {
    return new Response("Invalid payload", { status: 400 })
  }

  if (payload.type !== "block_actions") {
    return new Response("", { status: 200 })
  }

  const action = payload.actions?.[0]
  if (!action) {
    return new Response("", { status: 200 })
  }

  const pendingId = action.value
  if (!pendingId) {
    return new Response("Missing pending_action id", { status: 400 })
  }

  const nextStatus =
    action.action_id === "approve_lead"
      ? "approved"
      : action.action_id === "edit_lead"
        ? "edit_requested"
        : null

  if (!nextStatus) {
    return new Response("Unknown action", { status: 400 })
  }

  const supabase = createServiceClient()

  // Atomic claim: only the first click flips status off 'pending', so a
  // double-click can never insert the same lead twice.
  const { data: pending, error: claimErr } = await supabase
    .from("pending_actions")
    .update({
      status: nextStatus,
      decided_at: new Date().toISOString(),
      decided_by_slack: payload.user.id,
    })
    .eq("id", pendingId)
    .eq("status", "pending")
    .select("id, shop_id, action_type, payload")
    .maybeSingle()

  if (claimErr) {
    console.error("[slack] claim pending_action:", claimErr)
    return new Response("DB error", { status: 500 })
  }

  if (!pending) {
    // Already decided — silently ack so Slack doesn't retry.
    return Response.json({ ok: true, alreadyDecided: true })
  }

  const proposal = pending.payload as LeadProposal

  if (nextStatus === "approved" && pending.action_type === "create_lead") {
    const rollbackPending = async () => {
      await supabase
        .from("pending_actions")
        .update({
          status: "pending",
          decided_at: null,
          decided_by_slack: null,
        })
        .eq("id", pending.id)
    }

    const failApproval = async (reason: string, logErr: unknown) => {
      console.error(`[slack] ${reason}:`, logErr)
      await rollbackPending()
      await replaceOriginalMessage(
        payload.response_url,
        "Approval failed",
        [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":warning: We could not save the lead — please try again from Gradia.",
            },
          },
        ]
      )
    }

    const customerResult = await findOrCreateCustomer(supabase, pending.shop_id, {
      name: proposal.customer_name,
      phone: proposal.phone,
    })

    if (!customerResult.ok) {
      await failApproval("resolve customer after approval", customerResult.error)
      return new Response("Customer resolution failed", { status: 500 })
    }

    const { data: created, error: insertErr } = await supabase
      .from("leads")
      .insert({
        shop_id: pending.shop_id,
        customer_id: customerResult.customer.id,
        customer_name: proposal.customer_name,
        phone: proposal.phone,
        car_info: proposal.car_info,
        pin_notes: proposal.pin_notes,
        status: proposal.status,
      })
      .select("id")
      .single()

    if (insertErr || !created) {
      await failApproval("insert lead after approval", insertErr)
      return new Response("Insert failed", { status: 500 })
    }

    await supabase
      .from("pending_actions")
      .update({ result_id: created.id })
      .eq("id", pending.id)

    revalidatePath("/dashboard")
    revalidatePath("/leads")

    await replaceOriginalMessage(
      payload.response_url,
      `Lead approved · ${proposal.customer_name}`,
      leadApprovedBlocks({
        customerName: proposal.customer_name,
        phone: proposal.phone,
        carInfo: proposal.car_info,
        pinNotes: proposal.pin_notes,
        status: proposal.status,
        approverSlackId: payload.user.id,
      })
    )

    return Response.json({ ok: true })
  }

  if (nextStatus === "edit_requested") {
    await replaceOriginalMessage(
      payload.response_url,
      `Edit requested · ${proposal.customer_name}`,
      leadEditRequestedBlocks({
        customerName: proposal.customer_name,
        phone: proposal.phone,
        carInfo: proposal.car_info,
        status: proposal.status,
        approverSlackId: payload.user.id,
      })
    )
    return Response.json({ ok: true })
  }

  return new Response("", { status: 200 })
}
