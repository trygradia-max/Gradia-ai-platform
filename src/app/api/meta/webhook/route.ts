/**
 * Meta Messenger Platform webhook for Instagram DMs.
 *
 * GET: handles Meta's subscribe-time verification challenge. They
 * call us with `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
 * and expect us to echo the challenge back when the token matches
 * META_WEBHOOK_VERIFY_TOKEN.
 *
 * POST: receives messaging events. Verifies X-Hub-Signature-256
 * (HMAC-SHA256 of raw body with META_APP_SECRET), resolves the shop
 * by `entry.id` (the FB Page ID) against shops.instagram_page_id,
 * records the interaction (channel=instagram), classifies via Claude,
 * drops leads into HITL.
 */

import { revalidatePath } from "next/cache"
import type { SupabaseClient } from "@supabase/supabase-js"

import { findOrCreateCustomer } from "@/lib/customers"
import { getCrossChannelHint } from "@/lib/customer-context"
import {
  classifyInstagramDm,
  type InstagramClassification,
} from "@/lib/instagram-classifier"
import { draftFacebookReply } from "@/lib/facebook-drafter"
import { draftInstagramReply } from "@/lib/instagram-drafter"
import { recordInteraction } from "@/lib/memory"
import {
  extractMessageEvents,
  verifyMetaSignature,
  type MetaMessageEvent,
  type MetaWebhookPayload,
} from "@/lib/meta"
import {
  sendFacebookDmApprovalRequest,
  sendInstagramDmApprovalRequest,
  sendLeadApprovalRequest,
} from "@/lib/slack"
import { createServiceClient } from "@/lib/supabase/service"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()
  if (!expected) {
    console.error("[meta webhook] META_WEBHOOK_VERIFY_TOKEN not configured")
    return new Response("Not configured", { status: 500 })
  }
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")

  if (mode !== "subscribe" || token !== expected || !challenge) {
    return new Response("Forbidden", { status: 403 })
  }
  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get("x-hub-signature-256")
  if (!verifyMetaSignature({ rawBody, signature })) {
    return new Response("Invalid signature", { status: 401 })
  }

  let payload: MetaWebhookPayload
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  if (payload?.object !== "instagram" && payload?.object !== "page") {
    // Meta uses object="instagram" for IG-routed events; some legacy
    // setups still use "page". Ack anything else without processing.
    return Response.json({ ok: true, skipped: payload?.object ?? "unknown" })
  }

  const buckets = extractMessageEvents(payload)
  if (buckets.length === 0) return Response.json({ ok: true })

  const supabase = createServiceClient()

  let proposed = 0
  for (const { pageId, events } of buckets) {
    let channel: "instagram" | "facebook" = "instagram"
    const { data: igRow, error: igErr } = await supabase
      .from("shops")
      .select("*")
      .eq("instagram_page_id", pageId)
      .maybeSingle()
    if (igErr) {
      console.error("[meta webhook] IG shop lookup failed:", igErr)
      continue
    }
    let shop = (igRow as ShopRow | null) ?? null
    if (!shop) {
      const { data: fbRow, error: fbErr } = await supabase
        .from("shops")
        .select("*")
        .eq("facebook_page_id", pageId)
        .maybeSingle()
      if (fbErr) {
        console.error("[meta webhook] FB shop lookup failed:", fbErr)
        continue
      }
      shop = (fbRow as ShopRow | null) ?? null
      if (shop) channel = "facebook"
    }
    if (!shop) {
      console.warn("[meta webhook] no shop matched page_id", { pageId })
      continue
    }
    for (const event of events) {
      try {
        const fired = await handleMessage(supabase, shop, event, channel)
        if (fired) proposed += 1
      } catch (err) {
        console.error("[meta webhook] handle failed:", err)
      }
    }
  }

  if (proposed > 0) {
    revalidatePath("/approvals")
    revalidatePath("/dashboard")
  }

  return Response.json({ ok: true, proposed })
}

async function handleMessage(
  supabase: SupabaseClient,
  shop: ShopRow,
  event: MetaMessageEvent,
  channel: "instagram" | "facebook"
): Promise<boolean> {
  // Use the page-scoped sender id as the dedup key on customers.
  // For IG that's the IG sender id; for FB that's the PSID. We store
  // them on different customer columns so a shop using both channels
  // doesn't accidentally merge an IG sender with a Messenger PSID.
  const senderKey = event.senderId
  const customerResult = await findOrCreateCustomer(supabase, shop.id, {
    instagramHandle: channel === "instagram" ? senderKey : null,
    facebookId: channel === "facebook" ? senderKey : null,
  })
  const customerId = customerResult.ok ? customerResult.customer.id : null

  const body = event.text ?? "(non-text DM — likely image or video)"
  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId,
    channel,
    role: "customer",
    content: body,
    metadata: {
      meta_message_id: event.messageId,
      sender_id: event.senderId,
      page_id: event.recipientId,
      received_at: new Date(event.timestamp).toISOString(),
    },
  })

  if (!event.text) return false // attachments-only — capture, don't propose

  let classification: InstagramClassification | null = null
  try {
    classification = await classifyInstagramDm({
      senderId: event.senderId,
      body: event.text,
    })
  } catch (err) {
    console.warn(
      "[meta webhook] classification failed, skipping lead proposal:",
      err
    )
  }

  if (!classification || !classification.is_lead) return false

  await proposeLead(supabase, shop, event, customerId, classification, channel)
  // Best-effort auto-draft reply. Drafter or Slack failures don't
  // block the lead proposal that just landed.
  try {
    await proposeDraftReply(
      supabase,
      shop,
      event,
      customerId,
      classification,
      channel
    )
  } catch (err) {
    console.warn("[meta webhook] auto-draft reply failed:", err)
  }
  return true
}

async function proposeDraftReply(
  supabase: SupabaseClient,
  shop: ShopRow,
  event: MetaMessageEvent,
  customerId: string | null,
  classification: InstagramClassification,
  channel: "instagram" | "facebook"
): Promise<void> {
  const drafterInput = {
    shopName: shop.name,
    customerName: classification.customer_name,
    vehicle: classification.vehicle,
    service: classification.service,
    body: event.text ?? "",
  }
  const draft =
    channel === "instagram"
      ? await draftInstagramReply(drafterInput)
      : await draftFacebookReply(drafterInput)
  if (!draft) return

  const customerName = classification.customer_name?.trim() || null
  const channelLabel = channel === "instagram" ? "IG" : "FB"
  const reason = classification.service?.trim()
    ? `Reply to ${channelLabel} inquiry about ${classification.service.trim()}`
    : `Reply to inbound ${channelLabel} DM`

  const actionType =
    channel === "instagram" ? "send_instagram_dm" : "send_facebook_dm"
  const source =
    channel === "instagram" ? "instagram_auto_draft" : "facebook_auto_draft"

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: actionType,
      payload: {
        recipient_id: event.senderId,
        body: draft,
        customer_name: customerName,
        customer_id: customerId,
        reason,
        source,
        meta_inbound_message_id: event.messageId,
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()
  if (pendingErr || !pending) {
    console.error(
      `[meta webhook] ${actionType} pending_action insert failed:`,
      pendingErr
    )
    return
  }

  const slackPayload = {
    pendingActionId: pending.id,
    recipientId: event.senderId,
    customerName,
    body: draft,
    reason,
  }
  try {
    if (channel === "instagram") {
      await sendInstagramDmApprovalRequest(slackPayload)
    } else {
      await sendFacebookDmApprovalRequest(slackPayload)
    }
  } catch (err) {
    console.error(
      `[meta webhook] ${channelLabel} draft Slack send failed:`,
      err
    )
  }
}

async function proposeLead(
  supabase: SupabaseClient,
  shop: ShopRow,
  event: MetaMessageEvent,
  customerId: string | null,
  classification: InstagramClassification,
  channel: "instagram" | "facebook"
): Promise<void> {
  const channelLabel = channel === "instagram" ? "IG" : "FB"
  const customerName =
    classification.customer_name?.trim() ||
    `${channelLabel} ${event.senderId}`
  const phone = classification.phone?.trim() || ""
  const vehicle = classification.vehicle?.trim() || null
  const service = classification.service?.trim() || null
  const summary = classification.summary?.trim() || null
  const bodyPreview = (event.text ?? "").trim().slice(0, 280)

  const pinNotesParts = [
    summary,
    service ? `Requested: ${service}` : null,
    bodyPreview ? `Said: "${bodyPreview}"` : null,
    `${channelLabel} sender: ${event.senderId}`,
  ].filter((s): s is string => Boolean(s))
  const pinNotes = pinNotesParts.join(" — ") || null

  const senderIdKey =
    channel === "instagram" ? "instagram_sender_id" : "facebook_sender_id"

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "create_lead",
      payload: {
        customer_name: customerName,
        phone,
        car_info: vehicle,
        pin_notes: pinNotes,
        status: "new",
        source: channel,
        meta_message_id: event.messageId,
        [senderIdKey]: event.senderId,
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error("[meta webhook] pending_action insert failed:", pendingErr)
    return
  }

  const crossChannelHint = await getCrossChannelHint(
    supabase,
    shop.id,
    customerId,
    channel
  )

  try {
    await sendLeadApprovalRequest({
      pendingActionId: pending.id,
      customerName,
      phone,
      carInfo: vehicle,
      pinNotes,
      status: "new",
      crossChannelHint,
    })
  } catch (err) {
    console.error("[meta webhook] Slack send failed:", err)
  }
}
