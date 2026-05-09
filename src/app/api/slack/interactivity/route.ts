import { revalidatePath } from "next/cache"

import { executeApproval, markEditRequested } from "@/lib/approvals"
import { createServiceClient } from "@/lib/supabase/service"
import {
  leadApprovedBlocks,
  leadEditRequestedBlocks,
  noteApprovedBlocks,
  noteEditRequestedBlocks,
  replaceOriginalMessage,
  verifySlackSignature,
} from "@/lib/slack"

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

  const supabase = createServiceClient()
  const decider = { slackUserId: payload.user.id }

  if (action.action_id === "approve_lead") {
    const result = await executeApproval(supabase, pendingId, decider)

    if (!result.ok) {
      console.error("[slack] approve failed:", result.error)
      await replaceOriginalMessage(payload.response_url, "Approval failed", [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":warning: We could not save the lead — please try again from Gradia.",
          },
        },
      ])
      return new Response("Approval failed", { status: 500 })
    }

    if (result.status === "already_decided") {
      return Response.json({ ok: true, alreadyDecided: true })
    }

    revalidatePath("/dashboard")
    revalidatePath("/leads")
    revalidatePath("/approvals")

    if (result.actionType === "create_lead") {
      const { proposal } = result
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
    } else {
      const { proposal } = result
      await replaceOriginalMessage(
        payload.response_url,
        "Note saved",
        noteApprovedBlocks({
          content: proposal.content,
          customerName: proposal.customer_name,
          phone: proposal.phone,
          approverSlackId: payload.user.id,
        })
      )
    }

    return Response.json({ ok: true })
  }

  if (action.action_id === "edit_lead") {
    const result = await markEditRequested(supabase, pendingId, decider)

    if (!result.ok) {
      console.error("[slack] edit_requested failed:", result.error)
      return new Response("DB error", { status: 500 })
    }

    if (result.status === "already_decided") {
      return Response.json({ ok: true, alreadyDecided: true })
    }

    revalidatePath("/approvals")

    if (result.actionType === "create_lead") {
      const { proposal } = result
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
    } else {
      const { proposal } = result
      await replaceOriginalMessage(
        payload.response_url,
        "Edit requested · note",
        noteEditRequestedBlocks({
          content: proposal.content,
          customerName: proposal.customer_name,
          approverSlackId: payload.user.id,
        })
      )
    }

    return Response.json({ ok: true })
  }

  return new Response("Unknown action", { status: 400 })
}
