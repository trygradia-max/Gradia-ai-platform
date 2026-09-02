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
 *     approval engine (card lands in /approvals)
 *
 * The response is always empty TwiML — per OPERATIONS.md, every
 * outbound message must go through HITL. Auto-replies are out of
 * scope.
 *
 * Replay protection (P0-006, ADR-001): after signature verification
 * succeeds, the handler claims (provider='twilio', event_id=MessageSid)
 * in `provider_events` BEFORE any write or LLM call. Duplicate and
 * concurrent deliveries of the same MessageSid lose the claim and return
 * the same empty TwiML with zero side effects. Processing failures mark
 * the claim failed and return 5xx, so a provider retry can reclaim and
 * reprocess (reclaimed_failed / reclaimed_stale). Ordering is locked by
 * ADR-001 C3: an unverified request must NEVER reach the claim — a forged
 * payload cannot reserve (poison) a legitimate MessageSid.
 */

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import type { SupabaseClient } from "@supabase/supabase-js"

import { findOrCreateCustomer, normalizePhone } from "@/lib/customers"
import {
  formatKnowledgeForPrompt,
  searchShopKnowledge,
} from "@/lib/knowledge"
import { looksOptedIn, looksOptedOut } from "@/lib/agent-audience"
import { recordUsage } from "@/lib/credits"
import { FEATURES } from "@/lib/features"
import { recordInteraction } from "@/lib/memory"
import { looksLikeConfirm } from "@/lib/no-show-ladder"
import { getPricing, priceUsage } from "@/lib/pricing"
import {
  claimProviderEvent,
  completeProviderEvent,
  failProviderEvent,
  type ProviderEventClaim,
} from "@/lib/provider-events"
import { checkRateLimit } from "@/lib/rate-limit"
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

  // ── Everything below runs only on an authenticated Twilio request. ──

  // MessageSid is the durable provider event id (ADR-001: globally unique
  // within the Twilio namespace). A genuine inbound message always carries
  // one; without it there is nothing to claim, and processing without a
  // claim is forbidden — acknowledge with zero side effects.
  const messageSid = sms.messageSid.trim()
  if (!messageSid) {
    console.warn(
      "[twilio sms] signed request missing MessageSid — acknowledging without processing",
      { shopId: shop.id }
    )
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }

  // Claim strictly AFTER signature verification (ADR-001 C3) and strictly
  // BEFORE any write or LLM call. A claim-storage outage fails closed:
  // 5xx, never process unguarded — Twilio retries later.
  let claim: ProviderEventClaim
  try {
    claim = await claimProviderEvent(supabase, {
      provider: "twilio",
      eventId: messageSid,
      shopId: shop.id,
      // staleAfterSeconds default (300s) intentionally exceeds this
      // route's maxDuration (60s) — a live claimer can never be
      // reclaimed while still running.
    })
  } catch (err) {
    console.error("[twilio sms] provider-event claim failed:", err)
    return new Response("Server error", { status: 500 })
  }

  if (!claim.shouldProcess) {
    // Duplicate suppression is a normal outcome (the helper already emits
    // the [idempotency] info line P0-012 counts); this line adds the shop
    // for the duplicate-messaging runbook.
    console.info("[twilio sms] duplicate delivery suppressed", {
      messageSid,
      shopId: shop.id,
      outcome: claim.outcome,
    })
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }

  try {
    await handleMessage(supabase, shop, sms, claim)
  } catch (err) {
    console.error("[twilio sms] handle failed:", err)
    try {
      await failProviderEvent(supabase, "twilio", messageSid, err)
    } catch (markErr) {
      // Claim stays 'processing' — reclaimable as stale after the
      // threshold, so the event is never permanently stranded.
      console.error("[twilio sms] fail-mark failed:", markErr)
    }
    // 5xx keeps Twilio's retry path open: the failed claim is explicitly
    // reclaimable (reclaimed_failed), so a legitimate retry reprocesses.
    return new Response("Processing failed", { status: 500 })
  }

  try {
    await completeProviderEvent(supabase, "twilio", messageSid)
  } catch (err) {
    // Side effects already landed; return success so Twilio doesn't
    // retry into a duplicate. The claim stays 'processing' and is only
    // reachable again via a stale reclaim on an unusually late retry
    // (ADR-001-accepted at-least-once residue).
    console.error("[twilio sms] complete-mark failed:", err)
  }

  return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
}

async function handleMessage(
  supabase: SupabaseClient,
  shop: ShopRow,
  sms: TwilioInboundSms,
  claim: ProviderEventClaim
): Promise<void> {
  const fromPhone = normalizePhone(sms.from) ?? sms.from

  const customerResult = await findOrCreateCustomer(supabase, shop.id, {
    phone: fromPhone,
  })
  const customerId = customerResult.ok ? customerResult.customer.id : null

  // Retry-after-failure reprocesses the whole event (ADR-001), but the
  // first attempt may already have written the interaction row before it
  // failed. The claim serializes execution per MessageSid, so this
  // check-then-skip is race-free here — never re-insert the same inbound
  // message into the thread. First deliveries skip the lookup entirely.
  let interactionRecorded = false
  if (claim.outcome !== "claimed") {
    const { data: existing, error: existingErr } = await supabase
      .from("interactions")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("channel", "sms")
      .eq("role", "customer")
      .eq("metadata->>twilio_message_sid", sms.messageSid)
      .limit(1)
    if (existingErr) {
      throw new Error(
        `[twilio sms] reprocess interaction lookup failed: ${existingErr.message}`
      )
    }
    interactionRecorded = (existing?.length ?? 0) > 0
  }

  if (!interactionRecorded) {
    const recorded = await recordInteraction(supabase, {
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
    if (!recorded.ok) {
      // Losing the inbound message silently would strand the event as a
      // false success. Fail the claim so Twilio's retry reprocesses.
      throw new Error(
        `[twilio sms] interaction insert failed: ${recorded.error}`
      )
    }
  }

  // Consent ledger (B2): a STOP/START keyword updates the customer's marketing
  // opt-out / opt-in state — the affirmative-consent signal the send gate reads.
  // Write failures throw (compliance-critical): the failed claim lets the
  // provider retry re-apply consent instead of dropping it silently.
  if (customerId) {
    if (looksOptedOut(sms.body)) {
      const { error: consentErr } = await supabase
        .from("customers")
        .update({ sms_opted_out_at: new Date().toISOString(), marketing_consent_at: null })
        .eq("id", customerId)
      if (consentErr) {
        throw new Error(
          `[twilio sms] opt-out consent write failed: ${consentErr.message}`
        )
      }
    } else if (looksOptedIn(sms.body)) {
      const { error: consentErr } = await supabase
        .from("customers")
        .update({
          marketing_consent_at: new Date().toISOString(),
          marketing_consent_source: "sms_keyword",
          sms_opted_out_at: null,
        })
        .eq("id", customerId)
      if (consentErr) {
        throw new Error(
          `[twilio sms] opt-in consent write failed: ${consentErr.message}`
        )
      }
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

  // Inbound classification: rate-limited (spam ceiling) AND metered as
  // `inbound_classify` — wholesale cost in the ledger, retail 0 / credits 0
  // (shops aren't charged for receiving messages; 2026-07-13 audit fixed
  // this being invisible to the margin report).
  const classifyGate = await checkRateLimit(shop.id, "inbound_classify")
  if (!classifyGate.allowed) {
    console.warn(
      "[twilio sms] inbound-classify ceiling hit — captured without LLM:",
      shop.id
    )
    return
  }

  let classification: SmsClassification | null = null
  let classifyErr: unknown = null
  try {
    classification = await classifySms({ from: fromPhone, body: sms.body })
  } catch (err) {
    classifyErr = err
  }

  // Meter the LLM work regardless of outcome — the cost was incurred.
  // Replay-safe: (shop_id, kind, vendor_ref) carries a DB unique, so a
  // failure-retry re-metering the same MessageSid is a clean duplicate
  // (idempotent success). This write is REQUIRED before any downstream
  // staging: a real DB failure here must fail the claim so the retry can
  // land the ledger row — completing with the row permanently missing is
  // exactly the silent-loss D-024 forbids.
  {
    const pricing = await getPricing(supabase)
    const priced = priceUsage(pricing, "inbound_classify", 1)
    const metered = await recordUsage(supabase, shop.id, "inbound_classify", {
      quantity: 1,
      credits: 0, // cost-visibility SKU — never spends shop credits
      wholesaleCost: priced.wholesale_cost,
      retailCost: priced.retail_cost,
      vendorRef: sms.messageSid ?? null,
    })
    if (metered === "failed") {
      throw new Error(
        "[twilio sms] inbound_classify metering write failed — failing event for retry"
      )
    }
  }

  if (classifyErr) {
    // Classifier outage: fail the claim (after metering) so the provider's
    // retry reprocesses once the classifier is back — never a silent
    // captured-but-unclassified success (P0-006 manual acceptance step 4).
    throw classifyErr
  }

  if (!classification || !classification.is_lead) return

  await proposeLead(supabase, shop, sms, fromPhone, customerId, classification)
  // Best-effort auto-draft. A drafter failure must not block
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
    // Staging is the user-visible outcome of the whole pipeline — a lost
    // card is not a success. Fail the claim so a provider retry can
    // restage (the interaction re-insert is deduped on reprocess).
    throw new Error(
      `[twilio sms] pending_action insert failed: ${pendingErr?.message ?? "no row"}`
    )
  }
}
