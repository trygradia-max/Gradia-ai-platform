/**
 * Gradia Whisper processing endpoint.
 *
 * Accepts audio multipart upload from the dashboard mic button:
 *   1. Authenticate (user session, owner of the current shop)
 *   2. Transcribe via OpenAI Whisper
 *   3. Parse intent via Claude (create_lead | add_note)
 *   4. Insert pending_action of the correct type
 *   5. Fire Slack approval card
 *   6. Return result for the UI to toast
 *
 * Same HITL gate every other surface uses — voice-to-action proposes,
 * humans approve.
 */

import { revalidatePath } from "next/cache"

import {
  sendLeadApprovalRequest,
  sendNoteApprovalRequest,
} from "@/lib/slack"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  checkFeatureAccess,
  loadShopCreditFields,
  recordUsage,
} from "@/lib/credits"
import { getPricing, priceUsage } from "@/lib/pricing"
import { checkRateLimit } from "@/lib/rate-limit"
import { getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import {
  parseWhisperIntent,
  transcribeAudio,
  type WhisperIntent,
} from "@/lib/whisper"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Transcription (Whisper) + intent parse (Claude) easily exceed Vercel's
// 10 s Hobby default. 60 s is the max for Hobby — plenty for normal voice
// commands.
export const maxDuration = 60

const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // OpenAI Whisper file-size limit

type WhisperResult =
  | {
      ok: true
      intent: "create_lead" | "add_note"
      transcript: string
    }
  | { ok: false; error: string; transcript?: string }

function jsonResult(result: WhisperResult, status = 200): Response {
  return Response.json(result, { status })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return jsonResult({ ok: false, error: "Sign-in expired — refresh and try again." }, 401)
  }

  const shop = await getOptionalShop()
  if (!shop) {
    return jsonResult({ ok: false, error: "We need to set up our shop first." }, 403)
  }

  // Fail-closed: an inactive plan or an exhausted credit balance shuts
  // Whisper off before we spend a cent on transcription.
  const creditFields = await loadShopCreditFields(supabase, shop.id)
  if (!creditFields) {
    return jsonResult({ ok: false, error: "We need to set up our shop first." }, 403)
  }
  const access = await checkFeatureAccess(supabase, creditFields)
  if (!access.ok) {
    return jsonResult({ ok: false, error: access.reason }, access.status)
  }

  // Burst guard on top of the credit gate — a stuck client can't hammer
  // transcription.
  const burst = await checkRateLimit(shop.id, "whisper")
  if (!burst.allowed) {
    return jsonResult(
      { ok: false, error: "Give us a second to catch up — try again shortly." },
      429
    )
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return jsonResult({ ok: false, error: "Couldn't read upload." }, 400)
  }

  const file = formData.get("audio")
  if (!(file instanceof File)) {
    return jsonResult({ ok: false, error: "No audio attached." }, 400)
  }
  if (file.size === 0) {
    return jsonResult({ ok: false, error: "Didn't hear anything — try again." }, 400)
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return jsonResult({ ok: false, error: "Recording too long — keep it under 25 MB." }, 400)
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  let transcript: string
  try {
    transcript = await transcribeAudio(
      buffer,
      file.name || "recording.webm",
      file.type || "audio/webm"
    )
  } catch (err) {
    console.error("[whisper] transcribe failed:", err)
    return jsonResult({ ok: false, error: "Couldn't catch that — give us another shot." }, 500)
  }

  if (!transcript) {
    return jsonResult({ ok: false, error: "Didn't hear anything — try again." }, 400)
  }

  let intent: WhisperIntent
  try {
    intent = await parseWhisperIntent(transcript)
  } catch (err) {
    console.error("[whisper] intent parse failed:", err)
    // Graceful fallback: file as a note so the detailer's words aren't lost.
    intent = {
      type: "add_note",
      content: transcript,
      customer_name: "",
      phone: "",
    }
  }

  if (intent.type === "create_lead") {
    if (!intent.customer_name && !intent.phone) {
      return jsonResult({
        ok: false,
        error: "We need at least a name or phone for a lead — try again with one of those?",
        transcript,
      })
    }

    const pinNotes =
      [
        intent.service && `Requested: ${intent.service}`,
        intent.pin_notes,
      ]
        .filter((s): s is string => Boolean(s))
        .join(" — ") || null

    const proposal = {
      customer_name: intent.customer_name || "Whisper note",
      phone: intent.phone || "",
      car_info: intent.vehicle || null,
      pin_notes: pinNotes,
      status: "new" as const,
      source: "whisper",
      transcript,
    }

    const { data: pending, error: pendingErr } = await supabase
      .from("pending_actions")
      .insert({
        shop_id: shop.id,
        action_type: "create_lead",
        payload: proposal,
        requested_by: user.id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[whisper] pending_action insert failed:", pendingErr)
      return jsonResult({
        ok: false,
        error: "Couldn't queue that — try again.",
        transcript,
      }, 500)
    }

    try {
      await sendLeadApprovalRequest({
        pendingActionId: pending.id,
        customerName: proposal.customer_name,
        phone: proposal.phone,
        carInfo: proposal.car_info,
        pinNotes: proposal.pin_notes,
        status: "new",
      })
    } catch (err) {
      console.error("[whisper] Slack send failed:", err)
    }

    await meterWhisperNote(supabase, shop.id, pending.id)
    revalidatePath("/approvals")
    return jsonResult({ ok: true, intent: "create_lead", transcript })
  }

  // add_note path
  const noteProposal = {
    content: intent.content,
    customer_name: intent.customer_name || null,
    phone: intent.phone || null,
    source: "whisper",
    transcript,
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "add_note",
      payload: noteProposal,
      requested_by: user.id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error("[whisper] pending_action insert failed:", pendingErr)
    return jsonResult({
      ok: false,
      error: "Couldn't queue that — try again.",
      transcript,
    }, 500)
  }

  try {
    await sendNoteApprovalRequest({
      pendingActionId: pending.id,
      content: noteProposal.content,
      customerName: noteProposal.customer_name,
      phone: noteProposal.phone,
    })
  } catch (err) {
    console.error("[whisper] Slack note send failed:", err)
  }

  await meterWhisperNote(supabase, shop.id, pending.id)
  revalidatePath("/approvals")
  return jsonResult({ ok: true, intent: "add_note", transcript })
}

/** Locked menu: 3 credits per Whisper note (owner-initiated — metered;
 *  the staged approval itself is plumbing and stays free). */
async function meterWhisperNote(
  supabase: SupabaseClient,
  shopId: string,
  refId: string
): Promise<void> {
  const priced = priceUsage(await getPricing(supabase), "whisper_note", 1)
  await recordUsage(supabase, shopId, "whisper_note", {
    credits: priced.credits,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
    refId,
  })
}
