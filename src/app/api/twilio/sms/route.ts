/**
 * Twilio inbound SMS webhook.
 *
 * Twilio POSTs application/x-www-form-urlencoded payloads with fields
 * like From, To, Body, MessageSid, NumMedia, etc.
 *
 * Multi-tenancy: shop is resolved by matching the `To` number against
 * `shops.twilio_phone_number`. We use the service-role client to
 * bypass RLS during webhook processing.
 *
 * For every inbound message we:
 *   - resolve the customer by phone (findOrCreateCustomer)
 *   - record the interaction in the shared memory layer (channel=sms)
 *   - classify with Claude; if it's a real new inquiry (not a short
 *     follow-up in an existing thread), propose a lead via the HITL
 *     approval engine and post the Slack card
 *
 * The response is always empty TwiML — per OPERATIONS.md, every
 * outbound message must go through HITL. Auto-replies are out of
 * scope.
 */

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import type { SupabaseClient } from "@supabase/supabase-js"

import { findOrCreateCustomer, normalizePhone } from "@/lib/customers"
import { getCrossChannelHint } from "@/lib/customer-context"
import {
  formatKnowledgeForPrompt,
  searchShopKnowledge,
} from "@/lib/knowledge"
import { looksOptedIn, looksOptedOut } from "@/lib/agent-audience"
import { FEATURES } from "@/lib/features"
import { recordInteraction } from "@/lib/memory"
import { looksLikeConfirm } from "@/lib/no-show-ladder"
import { checkRateLimit } from "@/lib/rate-limit"
import {
  sendLeadApprovalRequest,
  sendSmsApprovalRequest,
} from "@/lib/slack"
import { classifySms, type SmsClassification } from "@/lib/sms-classifier"
import { draftSmsReply } from "@/lib/sms-drafter"
import { createServiceClient } from "@/lib/supabase/service"
import type { ShopRow } from "@/lib/types/database"
import {
  EMPTY_TWIML_RESPONSE,
  parseInboundSms,
  resolveTwilioCredentials,
  verifyTwilioSignature,
  type TwilioInboundSms,
} from "@/lib/twilio"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const TWIML_HEADERS = { "Content-Type": "text/xml; charset=utf-8" }

async function resolvePublicUrl(request: Request): Promise<string> {
  // Twilio signed the URL it actually called. Behind Vercel/proxies the
  // request.url isn't always that — prefer the forwarded host headers
  // (or GRADIA_DASHBOARD_URL origin) when present, fall back to request.url.
  const path = new URL(request.url).pathname
  const search = new URL(request.url).search

  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      const origin = new URL(configured).origin
      return `${origin}${path}${search}`
    } catch {
      // fall through
    }
  }

  const h = await headers()
  const forwardedHost = h.get("x-forwarded-host")
  const forwardedProto = h.get("x-forwarded-proto")
  if (forwardedHost) {
    const proto = forwardedProto ?? "https"
    return `${proto}://${forwardedHost}${path}${search}`
  }

  return request.url
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const form = new URLSearchParams(rawBody)
  const url = await resolvePublicUrl(request)
  const signature = request.headers.get("x-twilio-signature")

  // BYO Twilio: each shop can sign with their own auth token. We
  // must resolve the shop *before* verifying so we use the right
  // token. The peek at the `To` field is unverified, but we re-
  // verify the full payload before doing anything; mismatched
  // signatures still reject.
  const { parsed: sms } = parseInboundSms(form)
  if (!sms.from || !sms.to) {
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }

  const supabase = createServiceClient()

  const normalizedTo = normalizePhone(sms.to) ?? sms.to
  const { data: shopRow, error: shopErr } = await supabase
    .from("shops")
    .select("*")
    .eq("twilio_phone_number", normalizedTo)
    .maybeSingle()

  if (shopErr) {
    console.error("[twilio sms] shop lookup failed:", shopErr)
    return new Response("Server error", { status: 500 })
  }

  const shop = (shopRow as ShopRow | null) ?? null
  if (!shop) {
    console.warn(
      "[twilio sms] no shop matched the To number — acknowledging anyway",
      { to: sms.to }
    )
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }

  const creds = resolveTwilioCredentials(shop)
  if (!verifyTwilioSignature({ url, form, signature, creds })) {
    return new Response("Invalid signature", { status: 401 })
  }

  try {
    await handleMessage(supabase, shop, sms)
  } catch (err) {
    console.error("[twilio sms] handle failed:", err)
  }

  return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
}

async function handleMessage(
  supabase: SupabaseClient,
  shop: ShopRow,
  sms: TwilioInboundSms
): Promise<void> {
  const fromPhone = normalizePhone(sms.from) ?? sms.from

  const customerResult = await findOrCreateCustomer(supabase, shop.id, {
    phone: fromPhone,
  })
  const customerId = customerResult.ok ? customerResult.customer.id : null

  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId,
    channel: "sms",
    role: "customer",
    content: sms.body.trim() || "(empty SMS body)",
    metadata: {
      twilio_message_sid: sms.messageSid,
      from_phone: fromPhone,
      from_city: sms.fromCity,
      from_state: sms.fromState,
      from_country: sms.fromCountry,
      num_media: sms.numMedia,
    },
  })

  // Consent ledger (B2): a STOP/START keyword updates the customer's marketing
  // opt-out / opt-in state — the affirmative-consent signal the send gate reads.
  if (customerId) {
    if (looksOptedOut(sms.body)) {
      await supabase
        .from("customers")
        .update({ sms_opted_out_at: new Date().toISOString(), marketing_consent_at: null })
        .eq("id", customerId)
    } else if (looksOptedIn(sms.body)) {
      await supabase
        .from("customers")
        .update({
          marketing_consent_at: new Date().toISOString(),
          marketing_consent_source: "sms_keyword",
          sms_opted_out_at: null,
        })
        .eq("id", customerId)
    }
  }

  // No-show ladder (NEXT-2): a YES-style reply confirms the customer's nearest
  // upcoming unconfirmed appointment, dropping it off the at-risk/backfill list.
  // STOP wins over a confirm; never treat an opt-out as a confirmation.
  if (
    FEATURES.noShowLadder &&
    customerId &&
    !looksOptedOut(sms.body) &&
    looksLikeConfirm(sms.body)
  ) {
    const nowIso = new Date().toISOString()
    const { data: appt } = await supabase
      .from("appointments")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .is("confirmed_at", null)
      .gt("scheduled_at", nowIso)
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (appt) {
      await supabase
        .from("appointments")
        .update({ confirmed_at: nowIso })
        .eq("id", (appt as { id: string }).id)
    }
  }

  // Inbound classification is UNMETERED (a Haiku call per message) — its only
  // cost ceiling. Over the daily per-shop limit (spam flood), capture the
  // message above but skip the LLM classify + downstream draft.
  const classifyGate = await checkRateLimit(shop.id, "inbound_classify")
  if (!classifyGate.allowed) {
    console.warn(
      "[twilio sms] inbound-classify ceiling hit — captured without LLM:",
      shop.id
    )
    return
  }

  let classification: SmsClassification | null = null
  try {
    classification = await classifySms({ from: fromPhone, body: sms.body })
  } catch (err) {
    console.warn(
      "[twilio sms] classification failed, skipping lead proposal:",
      err
    )
  }

  if (!classification || !classification.is_lead) return

  await proposeLead(supabase, shop, sms, fromPhone, customerId, classification)
  // Best-effort auto-draft. Drafter or Slack failing must not block
  // the lead proposal we just staged.
  try {
    await proposeDraftReply(
      supabase,
      shop,
      sms,
      fromPhone,
      customerId,
      classification
    )
  } catch (err) {
    console.warn("[twilio sms] auto-draft failed:", err)
  }
  revalidatePath("/approvals")
  revalidatePath("/dashboard")
}

async function proposeDraftReply(
  supabase: SupabaseClient,
  shop: ShopRow,
  sms: TwilioInboundSms,
  fromPhone: string,
  customerId: string | null,
  classification: SmsClassification
): Promise<void> {
  // Ground the draft in any shop knowledge that overlaps with the
  // inquiry. Best-effort — RAG failures fall through to a generic
  // draft instead of blocking the auto-reply.
  const knowledgeQuery = [
    classification.summary,
    classification.service,
    sms.body,
  ]
    .filter((s): s is string => Boolean(s?.trim()))
    .join(" ")
  const matches = knowledgeQuery
    ? await searchShopKnowledge(supabase, shop.id, knowledgeQuery, {
        limit: 3,
      })
    : []
  const knowledge = formatKnowledgeForPrompt(matches)

  const draft = await draftSmsReply({
    shopName: shop.name,
    from: fromPhone,
    body: sms.body,
    summary: classification.summary,
    service: classification.service,
    vehicle: classification.vehicle,
    knowledge,
  })
  if (!draft) return

  const customerName = classification.customer_name?.trim() || null
  const reason = classification.service?.trim()
    ? `Reply to inquiry about ${classification.service.trim()}`
    : "Reply to new inquiry"

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "send_sms",
      payload: {
        to_phone: fromPhone,
        body: draft,
        customer_name: customerName,
        customer_id: customerId,
        reason,
        source: "sms_auto_draft",
        twilio_message_sid: sms.messageSid,
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error(
      "[twilio sms] send_sms pending_action insert failed:",
      pendingErr
    )
    return
  }

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: fromPhone,
      customerName,
      body: draft,
      reason,
    })
  } catch (err) {
    console.error("[twilio sms] draft Slack send failed:", err)
  }
}

async function proposeLead(
  supabase: SupabaseClient,
  shop: ShopRow,
  sms: TwilioInboundSms,
  fromPhone: string,
  customerId: string | null,
  classification: SmsClassification
): Promise<void> {
  const customerName = classification.customer_name?.trim() || fromPhone
  const vehicle = classification.vehicle?.trim() || null
  const service = classification.service?.trim() || null
  const summary = classification.summary?.trim() || null
  const bodyPreview = sms.body.trim().slice(0, 280)

  const pinNotesParts = [
    summary ? summary : null,
    service ? `Requested: ${service}` : null,
    bodyPreview ? `Said: "${bodyPreview}"` : null,
  ].filter((s): s is string => Boolean(s))
  const pinNotes = pinNotesParts.join(" — ") || null

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "create_lead",
      payload: {
        customer_name: customerName,
        phone: fromPhone,
        car_info: vehicle,
        pin_notes: pinNotes,
        status: "new",
        source: "sms",
        twilio_message_sid: sms.messageSid,
        from_phone: fromPhone,
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error("[twilio sms] pending_action insert failed:", pendingErr)
    return
  }

  const crossChannelHint = await getCrossChannelHint(
    supabase,
    shop.id,
    customerId,
    "sms"
  )

  try {
    await sendLeadApprovalRequest({
      pendingActionId: pending.id,
      customerName,
      phone: fromPhone,
      carInfo: vehicle,
      pinNotes,
      status: "new",
      crossChannelHint,
    })
  } catch (err) {
    console.error("[twilio sms] Slack send failed:", err)
  }
}
