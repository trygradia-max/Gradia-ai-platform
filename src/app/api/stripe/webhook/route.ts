/**
 * Stripe webhook for collection events.
 *
 * One endpoint handles every connected account because Stripe routes
 * Connect events through the platform's webhook with `account` set on
 * the event envelope. We act on:
 *   - invoice.paid             → log + Slack "Paid" notice
 *   - invoice.payment_failed   → log + Slack "Payment failed" notice
 *
 * Other events are ack'd with 200 and ignored. Stripe replays on
 * non-2xx, so silently ignoring is fine; we'll add handlers later
 * when there's a reason.
 *
 * Signature verification per Stripe spec (verifyStripeSignature in
 * lib/stripe.ts): `Stripe-Signature` header with `t=` timestamp and
 * one or more `v1=` HMAC-SHA256 signatures over `${ts}.${rawBody}`,
 * tolerance 5 minutes.
 */

import { revalidatePath } from "next/cache"

import {
  sendPaymentFailedNotice,
  sendPaymentReceivedNotice,
} from "@/lib/slack"
import { verifyStripeSignature } from "@/lib/stripe"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

type StripeInvoice = {
  id?: string
  number?: string | null
  hosted_invoice_url?: string | null
  status?: string
  customer_email?: string | null
  customer_name?: string | null
  amount_paid?: number
  amount_due?: number
  total?: number
}

type StripeEvent = {
  id?: string
  type?: string
  account?: string
  data?: { object?: StripeInvoice }
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get("stripe-signature")
  if (!verifyStripeSignature({ rawBody, signature })) {
    return new Response("Invalid signature", { status: 401 })
  }

  let event: StripeEvent
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  const eventType = event.type ?? ""
  if (eventType !== "invoice.paid" && eventType !== "invoice.payment_failed") {
    return Response.json({ ok: true, ignored: eventType || "unknown" })
  }

  const invoice = event.data?.object
  if (!invoice?.id) {
    return Response.json({ ok: true, ignored: "no invoice id" })
  }

  const supabase = createServiceClient()

  // Match the original outbound interaction we recorded when the
  // charge was approved. Stripe events on Connect arrive with the
  // connected `account` set on the envelope; we keep the lookup
  // scoped that way for safety.
  let interactionQuery = supabase
    .from("interactions")
    .select("id, shop_id, customer_id, metadata")
    .eq("metadata->>stripe_invoice_id", invoice.id)
  if (event.account) {
    // Limit to this account's shop. shops.stripe_account_id is unique
    // per account, so this resolves to one shop.
    const { data: shopRow } = await supabase
      .from("shops")
      .select("id")
      .eq("stripe_account_id", event.account)
      .maybeSingle()
    const shopId = (shopRow as { id: string } | null)?.id
    if (shopId) interactionQuery = interactionQuery.eq("shop_id", shopId)
  }

  const { data: interaction, error: lookupErr } =
    await interactionQuery.maybeSingle()

  if (lookupErr) {
    console.error("[stripe webhook] lookup failed:", lookupErr)
    // Return 200 anyway so Stripe doesn't replay forever on a DB hiccup.
    return Response.json({ ok: true })
  }

  const amount =
    typeof invoice.amount_paid === "number" && invoice.amount_paid > 0
      ? invoice.amount_paid
      : typeof invoice.total === "number"
        ? invoice.total
        : 0

  // Best-effort metadata update on the originating interaction.
  if (interaction) {
    const existing =
      (interaction.metadata as Record<string, unknown> | null) ?? {}
    const next: Record<string, unknown> = {
      ...existing,
      stripe_payment_status:
        eventType === "invoice.paid" ? "paid" : "payment_failed",
      stripe_payment_status_at: new Date().toISOString(),
    }
    if (eventType === "invoice.paid") {
      next.stripe_amount_paid = invoice.amount_paid ?? null
    }
    const { error: updateErr } = await supabase
      .from("interactions")
      .update({ metadata: next })
      .eq("id", interaction.id)
    if (updateErr) {
      console.error("[stripe webhook] metadata update failed:", updateErr)
    }
  } else {
    console.warn(
      "[stripe webhook] no matching interaction for invoice:",
      invoice.id
    )
  }

  try {
    if (eventType === "invoice.paid") {
      await sendPaymentReceivedNotice({
        customerName: invoice.customer_name ?? null,
        customerEmail: invoice.customer_email ?? null,
        amountCents: amount,
        invoiceNumber: invoice.number ?? null,
        invoiceUrl: invoice.hosted_invoice_url ?? null,
      })
    } else {
      await sendPaymentFailedNotice({
        customerName: invoice.customer_name ?? null,
        customerEmail: invoice.customer_email ?? null,
        amountCents: amount,
        invoiceNumber: invoice.number ?? null,
        invoiceUrl: invoice.hosted_invoice_url ?? null,
      })
    }
  } catch (err) {
    console.error("[stripe webhook] Slack notice failed:", err)
  }

  revalidatePath("/dashboard")
  return Response.json({ ok: true })
}
