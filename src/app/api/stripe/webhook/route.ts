/**
 * Stripe webhook for collection events.
 *
 * One endpoint handles every connected account because Stripe routes
 * Connect events through the platform's webhook with `account` set on
 * the event envelope. We act on:
 *   - invoice.paid             → log + Slack "Paid" notice
 *   - invoice.payment_failed   → log + Slack "Payment failed" notice
 *   - charge.refunded          → net the refund off our local mirror
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

import { dispatchAgentEvent } from "@/lib/agent-events"
import {
  sendPaymentFailedNotice,
  sendPaymentReceivedNotice,
  sendPaymentRefundedNotice,
} from "@/lib/slack"
import { creditsSpentThisPeriod } from "@/lib/credits"
import { PLAN, rolloverCredits } from "@/lib/pricing"
import {
  getSubscriptionItems,
  verifyStripeSignature,
  voiceAddonPriceId,
} from "@/lib/stripe"
import { createServiceClient } from "@/lib/supabase/service"
import type { ShopPlan, ShopRow } from "@/lib/types/database"
import type { SupabaseClient } from "@supabase/supabase-js"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

type StripeInvoice = {
  id?: string
  subscription?: string | null
  number?: string | null
  hosted_invoice_url?: string | null
  status?: string
  currency?: string | null
  description?: string | null
  customer_email?: string | null
  customer_name?: string | null
  amount_paid?: number
  amount_due?: number
  total?: number
  status_transitions?: {
    paid_at?: number | null
  } | null
  lines?: {
    data?: Array<{ description?: string | null }>
  } | null
}

type StripeCharge = {
  id?: string
  invoice?: string | null
  amount?: number
  amount_refunded?: number
  refunded?: boolean
  currency?: string | null
  billing_details?: {
    name?: string | null
    email?: string | null
  } | null
}

type StripeCheckoutSessionObj = {
  client_reference_id?: string | null
  subscription?: string | null
  mode?: string | null
  metadata?: { shop_id?: string } | null
}

type StripeSubscriptionObj = {
  id?: string
  status?: string
  metadata?: { shop_id?: string } | null
  items?: { data?: Array<{ price?: { id?: string } }> } | null
}

type StripeEvent = {
  id?: string
  type?: string
  account?: string
  data?: {
    object?:
      | StripeInvoice
      | StripeCharge
      | StripeCheckoutSessionObj
      | StripeSubscriptionObj
  }
}

function planFromSubStatus(status: string | undefined | null): ShopPlan {
  switch (status) {
    case "active":
    case "trialing":
      return "active"
    case "past_due":
    case "unpaid":
      return "past_due"
    default:
      return "free"
  }
}

/**
 * Subscription lifecycle for the $20/mo Gradia plan. These are PLATFORM
 * events (no `account` envelope), distinct from the Connect invoice/charge
 * events below. The shop is resolved by client_reference_id (checkout) or
 * stripe_subscription_id (updates).
 */
async function handleSubscriptionEvent(
  eventType: string,
  event: StripeEvent
): Promise<Response> {
  const supabase = createServiceClient()

  if (eventType === "checkout.session.completed") {
    const session = event.data?.object as StripeCheckoutSessionObj | undefined
    if (session?.mode === "payment") {
      return handlePackPurchase(supabase, session, event.id ?? null)
    }
    if (session?.mode !== "subscription") {
      return Response.json({ ok: true, ignored: "non-subscription checkout" })
    }
    const shopId =
      session.client_reference_id ?? session.metadata?.shop_id ?? null
    if (!shopId) return Response.json({ ok: true, ignored: "no shop ref" })

    // Did this checkout include the voice add-on as the second item?
    let voiceAddon = false
    const voicePrice = voiceAddonPriceId()
    if (session.subscription && voicePrice) {
      try {
        const items = await getSubscriptionItems(session.subscription)
        voiceAddon = items.some((i) => i.priceId === voicePrice)
      } catch (err) {
        console.error("[stripe webhook] items lookup failed:", err)
      }
    }

    const { error } = await supabase
      .from("shops")
      .update({
        plan: "active",
        stripe_subscription_id: session.subscription ?? null,
        ...(voiceAddon ? { voice_addon: true, voice_addon_ended_at: null } : {}),
      })
      .eq("id", shopId)
    if (error) console.error("[stripe webhook] sub activate failed:", error)
    revalidatePath("/billing")
    return Response.json({ ok: true })
  }

  const sub = event.data?.object as StripeSubscriptionObj | undefined
  if (!sub?.id) return Response.json({ ok: true, ignored: "no subscription id" })
  const deleted = eventType === "customer.subscription.deleted"
  const plan: ShopPlan = deleted ? "free" : planFromSubStatus(sub.status)

  // Voice add-on tracking: the add-on is a second item on the same
  // subscription (GRADIA_PRICING.md). Toggling it off disables the
  // receptionist on the NEXT call (vapi_stale → sync PATCHes the
  // fallback in); the number stays reserved — the 30-day release warning
  // keys off voice_addon_ended_at.
  const voicePrice = voiceAddonPriceId()
  const itemPrices = (sub.items?.data ?? [])
    .map((i) => i.price?.id)
    .filter(Boolean)
  const hasVoice =
    !deleted && Boolean(voicePrice) && itemPrices.includes(voicePrice as string)

  const { data: shopRow } = await supabase
    .from("shops")
    .select("id, voice_addon")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle()
  const shop = (shopRow as { id: string; voice_addon: boolean } | null) ?? null

  const update: Record<string, unknown> = { plan }
  if (shop && itemPrices.length > 0 && voicePrice) {
    if (hasVoice && !shop.voice_addon) {
      update.voice_addon = true
      update.voice_addon_ended_at = null
      update.vapi_stale = true
    } else if (!hasVoice && shop.voice_addon) {
      update.voice_addon = false
      update.voice_addon_ended_at = new Date().toISOString()
      update.voice_live = false
      update.vapi_stale = true
    }
  } else if (deleted && shop?.voice_addon) {
    update.voice_addon = false
    update.voice_addon_ended_at = new Date().toISOString()
    update.voice_live = false
    update.vapi_stale = true
  }

  const { error } = await supabase
    .from("shops")
    .update(update)
    .eq("stripe_subscription_id", sub.id)
  if (error) console.error("[stripe webhook] sub update failed:", error)
  revalidatePath("/billing")
  return Response.json({ ok: true })
}

/**
 * One-time pack purchase (mode=payment, metadata.pack). The grant insert
 * is idempotent across webhook retries — stripe_ref (session/event id)
 * carries a partial unique index; a duplicate insert errors and is
 * treated as already-processed.
 */
async function handlePackPurchase(
  supabase: SupabaseClient,
  session: StripeCheckoutSessionObj & { id?: string },
  eventId: string | null
): Promise<Response> {
  const shopId =
    session.client_reference_id ?? session.metadata?.shop_id ?? null
  const pack = (session.metadata as { pack?: string } | null)?.pack ?? null
  if (!shopId || (pack !== "credit" && pack !== "minute")) {
    return Response.json({ ok: true, ignored: "not a pack purchase" })
  }
  const { error } = await supabase.from("credit_grants").insert({
    shop_id: shopId,
    kind: pack === "credit" ? "credit_pack" : "minute_pack",
    credits: pack === "credit" ? PLAN.CREDIT_PACK.credits : 0,
    minutes: pack === "minute" ? PLAN.MINUTE_PACK.minutes : 0,
    stripe_ref: session.id ?? eventId,
  })
  if (error) {
    // 23505 = duplicate stripe_ref → webhook retry, already granted.
    if ((error as { code?: string }).code === "23505") {
      return Response.json({ ok: true, ignored: "duplicate grant" })
    }
    console.error("[stripe webhook] pack grant failed:", error)
    return Response.json({ ok: false }, { status: 500 })
  }
  revalidatePath("/billing")
  return Response.json({ ok: true, granted: pack })
}

/**
 * Platform subscription renewal (invoice.paid, no Connect account
 * envelope): advance the credit period and apply rollover — up to 25% of
 * unused INCLUDED credits carry one month (as a grant in the NEW period).
 * Idempotent via the invoice id on the grant's stripe_ref.
 */
async function handlePlatformRenewal(
  supabase: SupabaseClient,
  invoice: { id?: string; subscription?: string | null }
): Promise<Response> {
  const subId = invoice.subscription ?? null
  if (!subId || !invoice.id) {
    return Response.json({ ok: true, ignored: "no platform subscription" })
  }
  const { data } = await supabase
    .from("shops")
    .select("id, plan, credit_period_start")
    .eq("stripe_subscription_id", subId)
    .maybeSingle()
  const shop =
    (data as Pick<ShopRow, "id" | "plan" | "credit_period_start"> | null) ??
    null
  if (!shop) return Response.json({ ok: true, ignored: "no shop for sub" })

  const spent = await creditsSpentThisPeriod(supabase, shop)
  const rollover = rolloverCredits({
    includedCredits: PLAN.CORE_INCLUDED_CREDITS,
    spentCredits: spent,
  })

  const now = new Date().toISOString()
  const { error: periodError } = await supabase
    .from("shops")
    .update({ credit_period_start: now })
    .eq("id", shop.id)
  if (periodError) {
    console.error("[stripe webhook] period advance failed:", periodError)
    return Response.json({ ok: false }, { status: 500 })
  }

  if (rollover > 0) {
    const { error } = await supabase.from("credit_grants").insert({
      shop_id: shop.id,
      kind: "rollover",
      credits: rollover,
      minutes: 0,
      stripe_ref: invoice.id,
    })
    if (error && (error as { code?: string }).code !== "23505") {
      console.error("[stripe webhook] rollover grant failed:", error)
    }
  }
  revalidatePath("/billing")
  return Response.json({ ok: true, rollover })
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

  if (eventType === "charge.refunded") {
    return handleChargeRefunded(event)
  }

  if (
    eventType === "checkout.session.completed" ||
    eventType === "customer.subscription.updated" ||
    eventType === "customer.subscription.deleted"
  ) {
    return handleSubscriptionEvent(eventType, event)
  }

  if (eventType !== "invoice.paid" && eventType !== "invoice.payment_failed") {
    return Response.json({ ok: true, ignored: eventType || "unknown" })
  }

  const invoice = event.data?.object as StripeInvoice | undefined
  if (!invoice?.id) {
    return Response.json({ ok: true, ignored: "no invoice id" })
  }

  const supabase = createServiceClient()

  // PLATFORM invoice (no Connect account envelope) = a Gradia
  // subscription renewal → advance the credit period + apply rollover.
  // Connect invoices (event.account set) continue below unchanged.
  if (!event.account && eventType === "invoice.paid") {
    return handlePlatformRenewal(supabase, invoice)
  }

  // Resolve the connected account → shop up front. We'll reuse it for
  // both the interaction lookup AND the payments mirror insert.
  let shopId: string | null = null
  if (event.account) {
    const { data: shopRow } = await supabase
      .from("shops")
      .select("id")
      .eq("stripe_account_id", event.account)
      .maybeSingle()
    shopId = (shopRow as { id: string } | null)?.id ?? null
  }

  // Match the original outbound interaction we recorded when the
  // charge was approved.
  let interactionQuery = supabase
    .from("interactions")
    .select("id, shop_id, customer_id, metadata")
    .eq("metadata->>stripe_invoice_id", invoice.id)
  if (shopId) interactionQuery = interactionQuery.eq("shop_id", shopId)

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

  // Mirror paid invoices into the local payments table so BI chat +
  // future dashboard tiles can answer money questions cheaply. We
  // skip payment_failed — no money landed. Unique on (shop_id,
  // stripe_invoice_id) so Stripe retries no-op via onConflict.
  if (eventType === "invoice.paid" && shopId && amount > 0) {
    const description =
      invoice.description?.trim() ||
      invoice.lines?.data?.[0]?.description?.trim() ||
      null
    const paidAtIso =
      typeof invoice.status_transitions?.paid_at === "number"
        ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
        : new Date().toISOString()

    const { error: paymentErr } = await supabase
      .from("payments")
      .upsert(
        {
          shop_id: shopId,
          customer_id:
            (interaction as { customer_id?: string | null } | null)
              ?.customer_id ?? null,
          amount_cents: amount,
          currency: (invoice.currency ?? "usd").toLowerCase(),
          description,
          stripe_account_id: event.account ?? null,
          stripe_invoice_id: invoice.id,
          stripe_invoice_number: invoice.number ?? null,
          hosted_invoice_url: invoice.hosted_invoice_url ?? null,
          paid_at: paidAtIso,
        },
        { onConflict: "shop_id,stripe_invoice_id", ignoreDuplicates: false }
      )
    if (paymentErr) {
      console.error("[stripe webhook] payments upsert failed:", paymentErr)
    }
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

  // Fan out payment_received to event-driven custom agents (e.g.,
  // the thank-you SMS recipe). Best-effort — failures must not
  // affect the webhook ack to Stripe.
  if (eventType === "invoice.paid" && shopId) {
    let customerPhone: string | null = null
    const customerId =
      (interaction as { customer_id?: string | null } | null)?.customer_id ??
      null
    if (customerId) {
      const { data: customerRow } = await supabase
        .from("customers")
        .select("phone")
        .eq("id", customerId)
        .maybeSingle()
      customerPhone = (customerRow as { phone: string | null } | null)?.phone ?? null
    }

    const paidAtIso =
      typeof invoice.status_transitions?.paid_at === "number"
        ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
        : new Date().toISOString()

    try {
      await dispatchAgentEvent(
        {
          kind: "payment_received",
          shopId,
          customerName: invoice.customer_name ?? null,
          customerEmail: invoice.customer_email ?? null,
          customerPhone,
          customerId,
          amountCents: amount,
          stripeInvoiceId: invoice.id ?? null,
          paidAtIso,
        },
        supabase
      )
    } catch (err) {
      console.warn("[stripe webhook] payment_received dispatch failed:", err)
    }
  }

  revalidatePath("/dashboard")
  return Response.json({ ok: true })
}

async function handleChargeRefunded(event: StripeEvent): Promise<Response> {
  const charge = event.data?.object as StripeCharge | undefined
  const invoiceId = charge?.invoice ?? null
  const amountRefunded =
    typeof charge?.amount_refunded === "number" ? charge.amount_refunded : 0

  if (!invoiceId || amountRefunded <= 0) {
    return Response.json({ ok: true, ignored: "no invoice id or no refund" })
  }

  const supabase = createServiceClient()

  let shopId: string | null = null
  if (event.account) {
    const { data: shopRow } = await supabase
      .from("shops")
      .select("id")
      .eq("stripe_account_id", event.account)
      .maybeSingle()
    shopId = (shopRow as { id: string } | null)?.id ?? null
  }

  let q = supabase
    .from("payments")
    .select(
      "id, shop_id, amount_cents, refunded_amount_cents, stripe_invoice_number, hosted_invoice_url, description"
    )
    .eq("stripe_invoice_id", invoiceId)
  if (shopId) q = q.eq("shop_id", shopId)
  const { data: paymentRow, error: paymentErr } = await q.maybeSingle()

  if (paymentErr) {
    console.error("[stripe webhook] refund lookup failed:", paymentErr)
    return Response.json({ ok: true })
  }
  if (!paymentRow) {
    console.warn(
      "[stripe webhook] no payments row for refunded invoice:",
      invoiceId
    )
    return Response.json({ ok: true, ignored: "no local payment" })
  }

  const payment = paymentRow as {
    id: string
    shop_id: string
    amount_cents: number
    refunded_amount_cents: number
    stripe_invoice_number: string | null
    hosted_invoice_url: string | null
    description: string | null
  }
  // Clamp to gross so the CHECK constraint is happy if Stripe ever
  // sends amount_refunded > amount_paid (e.g. tip refunds we don't
  // track). Won't happen in our flow, but defensive is cheap.
  const clampedRefund = Math.min(amountRefunded, payment.amount_cents)
  const fullyRefunded = clampedRefund >= payment.amount_cents

  if (clampedRefund === payment.refunded_amount_cents) {
    // Already mirrored; Stripe is retrying or this is a duplicate event.
    return Response.json({ ok: true, idempotent: true })
  }

  const { error: updateErr } = await supabase
    .from("payments")
    .update({
      refunded_amount_cents: clampedRefund,
      refunded_at: new Date().toISOString(),
    })
    .eq("id", payment.id)

  if (updateErr) {
    console.error("[stripe webhook] payments refund update failed:", updateErr)
  }

  // Mirror onto the originating interaction so the customer timeline
  // shows it.
  const { data: interactionRow } = await supabase
    .from("interactions")
    .select("id, metadata")
    .eq("metadata->>stripe_invoice_id", invoiceId)
    .eq("shop_id", payment.shop_id)
    .maybeSingle()
  if (interactionRow) {
    const meta =
      ((interactionRow as { metadata: Record<string, unknown> | null }).metadata) ??
      {}
    const nextMeta: Record<string, unknown> = {
      ...meta,
      stripe_refund_amount: clampedRefund,
      stripe_refund_status: fullyRefunded ? "refunded" : "partially_refunded",
      stripe_refund_at: new Date().toISOString(),
    }
    const { error: interactionErr } = await supabase
      .from("interactions")
      .update({ metadata: nextMeta })
      .eq("id", (interactionRow as { id: string }).id)
    if (interactionErr) {
      console.error(
        "[stripe webhook] refund interaction update failed:",
        interactionErr
      )
    }
  }

  try {
    await sendPaymentRefundedNotice({
      customerName: charge?.billing_details?.name ?? null,
      customerEmail: charge?.billing_details?.email ?? null,
      refundedAmountCents: clampedRefund,
      grossAmountCents: payment.amount_cents,
      fullyRefunded,
      invoiceNumber: payment.stripe_invoice_number,
      invoiceUrl: payment.hosted_invoice_url,
    })
  } catch (err) {
    console.error("[stripe webhook] refund Slack notice failed:", err)
  }

  revalidatePath("/dashboard")
  return Response.json({ ok: true })
}
