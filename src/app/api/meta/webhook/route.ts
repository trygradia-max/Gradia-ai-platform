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
import { recordInteraction } from "@/lib/memory"
import {
  extractMessageEvents,
  verifyMetaSignature,
  type MetaMessageEvent,
  type MetaWebhookPayload,
} from "@/lib/meta"
import { sendLeadApprovalRequest } from "@/lib/slack"
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
    const { data: shopRow, error: shopErr } = await supabase
      .from("shops")
      .select("*")
      .eq("instagram_page_id", pageId)
      .maybeSingle()
    if (shopErr) {
      console.error("[meta webhook] shop lookup failed:", shopErr)
      continue
    }
    const shop = (shopRow as ShopRow | null) ?? null
    if (!shop) {
      console.warn("[meta webhook] no shop matched page_id", { pageId })
      continue
    }
    for (const event of events) {
      try {
        const fired = await handleMessage(supabase, shop, event)
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
  event: MetaMessageEvent
): Promise<boolean> {
  // Use the page-scoped sender id as the dedup key on customers.
  // We don't get the @handle in the webhook; resolving it requires
  // an extra Graph API call. For pilot we store the opaque sender id
  // and live with it — the dedup property is what we need.
  const senderKey = event.senderId
  const customerResult = await findOrCreateCustomer(supabase, shop.id, {
    instagramHandle: senderKey,
  })
  const customerId = customerResult.ok ? customerResult.customer.id : null

  const body = event.text ?? "(non-text DM — likely image or video)"
  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId,
    channel: "instagram",
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

  await proposeLead(supabase, shop, event, customerId, classification)
  return true
}

async function proposeLead(
  supabase: SupabaseClient,
  shop: ShopRow,
  event: MetaMessageEvent,
  customerId: string | null,
  classification: InstagramClassification
): Promise<void> {
  const customerName =
    classification.customer_name?.trim() || `IG ${event.senderId}`
  const phone = classification.phone?.trim() || ""
  const vehicle = classification.vehicle?.trim() || null
  const service = classification.service?.trim() || null
  const summary = classification.summary?.trim() || null
  const bodyPreview = (event.text ?? "").trim().slice(0, 280)

  const pinNotesParts = [
    summary,
    service ? `Requested: ${service}` : null,
    bodyPreview ? `Said: "${bodyPreview}"` : null,
    `IG sender: ${event.senderId}`,
  ].filter((s): s is string => Boolean(s))
  const pinNotes = pinNotesParts.join(" — ") || null

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
        source: "instagram",
        meta_message_id: event.messageId,
        instagram_sender_id: event.senderId,
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
    "instagram"
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
