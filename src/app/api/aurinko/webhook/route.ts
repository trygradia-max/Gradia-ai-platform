/**
 * Aurinko email webhook.
 *
 * Payload shape (per Aurinko docs):
 *   {
 *     subscription: number,
 *     resource: string,
 *     accountId: number,
 *     payloads: [{ id: string, changeType: "created" | "updated" | "deleted" }]
 *   }
 *
 * Multi-tenancy: shop is resolved by matching `accountId` against
 * `shops.aurinko_account_id`. We use the service-role client to bypass
 * RLS during webhook processing.
 *
 * For each "created" payload on /email/messages we:
 *   - fetch the full message via Aurinko
 *   - skip messages the shop's own connected mailbox sent (outbound copies)
 *   - record the interaction in the shared memory layer (channel=email)
 *   - classify with Claude; if it's a real inquiry, propose a lead
 *     through the HITL approval engine and post the Slack card
 */

import { revalidatePath } from "next/cache"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  getEmailMessage,
  verifyAurinkoSignature,
  type AurinkoMessage,
} from "@/lib/aurinko"
import { tryDecryptSecret } from "@/lib/crypto"
import { findOrCreateCustomer } from "@/lib/customers"
import { classifyEmail, type EmailClassification } from "@/lib/email-classifier"
import { draftEmailReply } from "@/lib/email-drafter"
import { recordInteraction } from "@/lib/memory"
import {
  sendEmailApprovalRequest,
  sendLeadApprovalRequest,
} from "@/lib/slack"
import { createServiceClient } from "@/lib/supabase/service"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

type Payload = {
  id?: string
  changeType?: string
}

type Notification = {
  subscription?: number | string
  resource?: string
  accountId?: number
  payloads?: Payload[]
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const timestamp = request.headers.get("x-aurinko-request-timestamp")
  const signature = request.headers.get("x-aurinko-signature")

  if (!verifyAurinkoSignature({ rawBody, timestamp, signature })) {
    return new Response("Invalid signature", { status: 401 })
  }

  let notification: Notification
  try {
    notification = JSON.parse(rawBody) as Notification
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  const accountId = notification.accountId
  const payloads = notification.payloads ?? []
  if (typeof accountId !== "number" || payloads.length === 0) {
    return Response.json({ ok: true, skipped: "no payloads" })
  }

  const supabase = createServiceClient()
  const { data: shopRow, error: shopErr } = await supabase
    .from("shops")
    .select("*")
    .eq("aurinko_account_id", accountId)
    .maybeSingle()

  if (shopErr) {
    console.error("[aurinko webhook] shop lookup failed:", shopErr)
    return new Response("Server error", { status: 500 })
  }

  const shop = (shopRow as ShopRow | null) ?? null
  const accessToken = tryDecryptSecret(shop?.aurinko_access_token_enc)
  if (!shop || !accessToken) {
    console.warn(
      "[aurinko webhook] no shop matched accountId, token missing, or decryption failed",
      { accountId }
    )
    // Ack so Aurinko doesn't retry forever — we can't process it anyway.
    return Response.json({ ok: true, skipped: "no shop" })
  }

  const isEmail = (notification.resource ?? "").includes("/email/messages")

  let proposed = 0
  for (const payload of payloads) {
    if (!isEmail) continue
    if (payload.changeType !== "created") continue
    if (!payload.id) continue

    try {
      const handled = await handleMessage(supabase, shop, accessToken, payload.id)
      if (handled) proposed += 1
    } catch (err) {
      console.error("[aurinko webhook] message handle failed:", err)
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
  accessToken: string,
  messageId: string
): Promise<boolean> {
  const message = await getEmailMessage(accessToken, messageId)

  // Skip messages the connected mailbox sent (outbound copies show up
  // on the same subscription stream).
  const senderEmail = (message.fromEmail ?? "").trim().toLowerCase()
  const ownEmail = (shop.aurinko_account_email ?? "").trim().toLowerCase()
  if (senderEmail && ownEmail && senderEmail === ownEmail) {
    return false
  }

  // Best-effort customer resolution. Emails without a usable From address
  // still get logged as an interaction but skipped for lead capture.
  let customerId: string | null = null
  if (senderEmail) {
    const result = await findOrCreateCustomer(supabase, shop.id, {
      email: senderEmail,
      name: message.fromName,
    })
    if (result.ok) customerId = result.customer.id
  }

  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId,
    channel: "email",
    role: "customer",
    content: interactionContent(message),
    metadata: {
      aurinko_message_id: message.id,
      from_email: senderEmail || null,
      from_name: message.fromName,
      subject: message.subject,
      received_at: message.receivedAt,
    },
  })

  if (!senderEmail) return false

  let classification: EmailClassification | null = null
  try {
    classification = await classifyEmail({
      from: composeFrom(message),
      subject: message.subject ?? "",
      body: message.bodyPlain ?? "",
    })
  } catch (err) {
    console.warn(
      "[aurinko webhook] classification failed, treating as inquiry:",
      err
    )
  }

  if (classification && !classification.is_lead) return false

  const proposed = await proposeLead(
    supabase,
    shop,
    message,
    senderEmail,
    classification
  )
  // Best-effort auto-draft reply. Failures here must not block the
  // lead proposal that just landed.
  try {
    await proposeDraftEmailReply(
      supabase,
      shop,
      message,
      senderEmail,
      customerId,
      classification
    )
  } catch (err) {
    console.warn("[aurinko webhook] auto-draft email reply failed:", err)
  }
  return proposed
}

async function proposeDraftEmailReply(
  supabase: SupabaseClient,
  shop: ShopRow,
  message: AurinkoMessage,
  senderEmail: string,
  customerId: string | null,
  classification: EmailClassification | null
): Promise<void> {
  const draft = await draftEmailReply({
    shopName: shop.name,
    from: senderEmail,
    subject: message.subject ?? "",
    body: message.bodyPlain ?? "",
    summary: classification?.summary ?? "",
    service: classification?.service ?? "",
    vehicle: classification?.vehicle ?? "",
  })
  if (!draft) return

  const customerName = classification?.customer_name?.trim() || message.fromName || null
  const reason = classification?.service?.trim()
    ? `Reply to inquiry about ${classification.service.trim()}`
    : "Reply to new email inquiry"

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "send_email",
      payload: {
        to_email: senderEmail,
        subject: draft.subject,
        body: draft.body,
        customer_name: customerName,
        customer_id: customerId,
        reason,
        source: "email_auto_draft",
        aurinko_inbound_message_id: message.id,
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error(
      "[aurinko webhook] send_email pending_action insert failed:",
      pendingErr
    )
    return
  }

  try {
    await sendEmailApprovalRequest({
      pendingActionId: pending.id,
      toEmail: senderEmail,
      customerName,
      subject: draft.subject,
      body: draft.body,
      reason,
    })
  } catch (err) {
    console.error("[aurinko webhook] email draft Slack send failed:", err)
  }
}

function interactionContent(m: AurinkoMessage): string {
  const subject = m.subject?.trim() || "(no subject)"
  const body = (m.bodyPlain ?? "").trim()
  return body ? `Subject: ${subject}\n\n${body}` : `Subject: ${subject}`
}

function composeFrom(m: AurinkoMessage): string {
  const name = m.fromName?.trim()
  const email = m.fromEmail?.trim()
  if (name && email) return `${name} <${email}>`
  return email || name || "(unknown sender)"
}

async function proposeLead(
  supabase: SupabaseClient,
  shop: ShopRow,
  message: AurinkoMessage,
  senderEmail: string,
  classification: EmailClassification | null
): Promise<boolean> {
  const customerName =
    classification?.customer_name?.trim() ||
    message.fromName?.trim() ||
    senderEmail

  const phone = classification?.phone?.trim() ?? ""
  const vehicle = classification?.vehicle?.trim() || null
  const service = classification?.service?.trim() || null
  const summary = classification?.summary?.trim() || null

  const pinNotesParts = [
    summary ? summary : null,
    service ? `Requested: ${service}` : null,
    `From: ${senderEmail}`,
    message.subject ? `Subject: ${message.subject}` : null,
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
        source: "email",
        aurinko_message_id: message.id,
        from_email: senderEmail,
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error("[aurinko webhook] pending_action insert failed:", pendingErr)
    return false
  }

  try {
    await sendLeadApprovalRequest({
      pendingActionId: pending.id,
      customerName,
      phone,
      carInfo: vehicle,
      pinNotes,
      status: "new",
    })
  } catch (err) {
    console.error("[aurinko webhook] Slack send failed:", err)
  }

  return true
}
