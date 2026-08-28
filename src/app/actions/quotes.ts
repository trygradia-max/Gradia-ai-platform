"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { executeApproval } from "@/lib/approvals"
import { recordInteraction } from "@/lib/memory"
import { moveLeadToStage } from "@/lib/pipeline"
import {
  buildQuoteLineItem,
  computeQuoteTotals,
  quoteEmailBody,
  quotePath,
  quoteSmsBody,
  type QuotableService,
} from "@/lib/quotes"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { parseVehicle } from "@/lib/vehicle"
import { upsertCustomerVehicle, vehiclesByCustomerIds, type VehicleLite } from "@/lib/vehicles"
import type {
  CustomerRow,
  QuoteRow,
  ServiceRow,
  VehicleSizeClass,
} from "@/lib/types/database"

/**
 * Quote actions (CRM C3b). Prices resolve through lib/service-pricing at
 * creation time; sending REUSES the one send path — the owner's click stages
 * a send_sms/send_email pending action and approves it in the same breath,
 * so the A2P gate, quiet hours, opt-out, and cooldown machinery all apply
 * exactly as they do to every other outbound message. A held send stays in
 * /approvals rather than silently dropping.
 */

async function publicBaseUrl(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

const createQuoteSchema = z.object({
  customerId: z.string().uuid(),
  vehicleId: z.string().uuid().nullable().optional(),
  leadId: z.string().uuid().nullable().optional(),
  selections: z
    .array(
      z.object({
        serviceId: z.string().uuid(),
        multiplierKeys: z.array(z.string().max(60)).max(12).default([]),
      })
    )
    .min(1, "Pick at least one service."),
  discountDollars: z.number().min(0).max(1_000_000).optional(),
  customerNote: z.string().max(2000).nullable().optional(),
  internalNote: z.string().max(2000).nullable().optional(),
  validDays: z.number().int().min(1).max(365).optional(),
})

export type CreateQuoteResult =
  | { ok: true; quoteId: string; publicToken: string | null; totalCents: number }
  | { ok: false; error: string }

export async function createOwnerQuote(
  input: z.infer<typeof createQuoteSchema>
): Promise<CreateQuoteResult> {
  const parsed = createQuoteSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the quote." }
  }
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: svcData } = await supabase
    .from("services")
    .select("*")
    .eq("shop_id", shop.id)
    .in(
      "id",
      parsed.data.selections.map((s) => s.serviceId)
    )
  const services = (svcData as ServiceRow[] | null) ?? []
  if (services.length === 0) return { ok: false, error: "Those services weren't found." }

  let sizeClass: VehicleSizeClass | null = null
  if (parsed.data.vehicleId) {
    const { data: veh } = await supabase
      .from("vehicles")
      .select("size_class")
      .eq("id", parsed.data.vehicleId)
      .eq("shop_id", shop.id)
      .maybeSingle()
    sizeClass = (veh as { size_class: VehicleSizeClass | null } | null)?.size_class ?? null
  }

  const lineItems = parsed.data.selections
    .map((sel) => {
      const svc = services.find((s) => s.id === sel.serviceId)
      if (!svc) return null
      return buildQuoteLineItem(svc as QuotableService, sizeClass, sel.multiplierKeys)
    })
    .filter((li): li is NonNullable<typeof li> => li !== null)
  const totals = computeQuoteTotals(
    lineItems,
    Math.round((parsed.data.discountDollars ?? 0) * 100)
  )

  const validUntil = parsed.data.validDays
    ? new Date(Date.now() + parsed.data.validDays * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : null

  const { data: quote, error } = await supabase
    .from("quotes")
    .insert({
      shop_id: shop.id,
      customer_id: parsed.data.customerId,
      vehicle_id: parsed.data.vehicleId ?? null,
      lead_id: parsed.data.leadId ?? null,
      status: "draft",
      line_items: lineItems,
      ...totals,
      customer_note: parsed.data.customerNote?.trim() || null,
      internal_note: parsed.data.internalNote?.trim() || null,
      valid_until: validUntil,
      created_by: "owner",
    })
    .select("id, public_token, total_cents")
    .single()
  if (error || !quote) {
    return {
      ok: false,
      error: error?.message ?? "Couldn't save the quote (is the C1 migration applied?)",
    }
  }
  const q = quote as { id: string; public_token: string | null; total_cents: number }

  if (parsed.data.leadId) {
    // Link the pipeline card to its quote (best-effort, C1 column).
    await supabase
      .from("leads")
      .update({ quote_id: q.id })
      .eq("id", parsed.data.leadId)
      .eq("shop_id", shop.id)
  }

  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId: parsed.data.customerId,
    channel: "note",
    role: "system",
    content: `Quote drafted — ${lineItems.length} item${lineItems.length === 1 ? "" : "s"}.`,
    metadata: { kind: "quote", quote_id: q.id, event: "drafted", source: "owner" },
  })

  revalidatePath("/customers")
  return { ok: true, quoteId: q.id, publicToken: q.public_token, totalCents: q.total_cents }
}

export type SendQuoteResult =
  | { ok: true; via: "sms" | "email" }
  | { ok: false; held: boolean; error: string }

/**
 * Send a quote — the owner's click is the approval. We stage the exact
 * send_sms/send_email pending action every other outbound uses, then execute
 * it immediately as this user. If the send path holds it (quiet hours, A2P
 * pending, opt-out), it stays waiting in /approvals and we say so.
 */
export async function sendQuote(
  quoteId: string,
  via: "sms" | "email"
): Promise<SendQuoteResult> {
  const user = await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: quoteData } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const quote = quoteData as QuoteRow | null
  if (!quote) return { ok: false, held: false, error: "Quote not found." }
  if (!quote.public_token) {
    return { ok: false, held: false, error: "Quote has no public link yet." }
  }

  const { data: custData } = await supabase
    .from("customers")
    .select("id, name, phone, email")
    .eq("id", quote.customer_id)
    .maybeSingle()
  const customer = custData as Pick<CustomerRow, "id" | "name" | "phone" | "email"> | null
  if (!customer) return { ok: false, held: false, error: "Customer not found." }

  const url = `${await publicBaseUrl()}${quotePath(quote.public_token)}`

  let pendingPayload: Record<string, unknown>
  let actionType: "send_sms" | "send_email"
  if (via === "sms") {
    if (!customer.phone) {
      return { ok: false, held: false, error: "No phone on file — try email." }
    }
    actionType = "send_sms"
    pendingPayload = {
      to_phone: customer.phone,
      body: quoteSmsBody({
        shopName: shop.name,
        customerName: customer.name,
        totalCents: quote.total_cents,
        url,
      }),
      customer_name: customer.name,
      customer_id: customer.id,
      reason: `Quote ${quoteId}`,
      category: "transactional",
      quote_id: quoteId,
    }
  } else {
    if (!customer.email) {
      return { ok: false, held: false, error: "No email on file — try text." }
    }
    actionType = "send_email"
    const email = quoteEmailBody({
      shopName: shop.name,
      customerName: customer.name,
      totalCents: quote.total_cents,
      url,
      validUntil: quote.valid_until,
    })
    pendingPayload = {
      to_email: customer.email,
      subject: email.subject,
      body: email.body,
      customer_name: customer.name,
      customer_id: customer.id,
      reason: `Quote ${quoteId}`,
      quote_id: quoteId,
    }
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: actionType,
      payload: pendingPayload,
      requested_by: user.id,
    })
    .select("id")
    .single()
  if (pendingErr || !pending) {
    return { ok: false, held: false, error: pendingErr?.message ?? "Couldn't stage the send." }
  }

  const result = await executeApproval(
    supabase,
    (pending as { id: string }).id,
    shop.id,
    { userId: user.id }
  )
  if (!result.ok) {
    // The send path held it (A2P / quiet hours / opt-out) — it's rolled back
    // to pending, visible in /approvals, and goes out when approvable.
    return { ok: false, held: true, error: result.error }
  }

  await supabase
    .from("quotes")
    .update({
      status: quote.status === "draft" || quote.status === "sent" ? "sent" : quote.status,
      sent_via: quote.sent_via && quote.sent_via !== via ? "both" : via,
      sent_at: quote.sent_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", quoteId)

  // Auto-move (C2, code not LLM): quote sent → pipeline card to quote_sent.
  if (quote.lead_id) {
    await moveLeadToStage(supabase, shop.id, quote.lead_id, "quote_sent")
  }

  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId: customer.id,
    channel: "note",
    role: "system",
    content: `Quote sent by ${via === "sms" ? "text" : "email"}.`,
    metadata: { kind: "quote", quote_id: quoteId, event: "sent", via },
  })

  revalidatePath("/customers")
  return { ok: true, via }
}

export type QuoteListEntry = QuoteRow & { customer_name: string | null }

/** Quotes tab — status-grouped list data. */
export async function listQuotesForCurrentShop(): Promise<QuoteListEntry[]> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("quotes")
    .select("*, customers(name)")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) {
    console.warn("[quotes] list skipped (pre-C1?):", error.message)
    return []
  }
  return (
    (data as (QuoteRow & { customers: { name: string | null } | null })[] | null) ?? []
  ).map(({ customers, ...q }) => ({ ...q, customer_name: customers?.name ?? null }))
}

/** Vehicles for the builder's picker. */
export async function getCustomerVehicles(customerId: string): Promise<VehicleLite[]> {
  const shop = await requireShop()
  const supabase = await createClient()
  const map = await vehiclesByCustomerIds(supabase, shop.id, [customerId])
  return map.get(customerId) ?? []
}

/** Inline vehicle create from the builder ("2021 Tesla Model Y, white"). */
export async function addCustomerVehicleFromText(
  customerId: string,
  text: string
): Promise<{ ok: true; vehicles: VehicleLite[] } | { ok: false; error: string }> {
  const shop = await requireShop()
  const supabase = await createClient()
  const parsed = parseVehicle(text)
  if (!parsed.make && !parsed.model) {
    return { ok: false, error: "Couldn't read that — try \"2021 Tesla Model Y, white\"." }
  }
  await upsertCustomerVehicle(supabase, shop.id, customerId, parsed)
  const map = await vehiclesByCustomerIds(supabase, shop.id, [customerId])
  return { ok: true, vehicles: map.get(customerId) ?? [] }
}
