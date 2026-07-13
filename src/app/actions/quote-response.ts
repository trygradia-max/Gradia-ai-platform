"use server"

import { recordInteraction } from "@/lib/memory"
import { moveLeadToStage } from "@/lib/pipeline"
import { createServiceClient } from "@/lib/supabase/service"
import type { QuoteRow, ShopRow } from "@/lib/types/database"

/**
 * Public quote responses (CRM C3b) — the /q/[token] page's actions. The
 * token IS the auth (128-bit, unguessable, single quote scope); everything
 * runs under the service client with shop_id taken from the quote row.
 *
 * Book Now inherits the shop's EXISTING booking rule (resolved decision #3):
 *   - calendar_link → the page links out; nothing staged.
 *   - propose_booking (default) → accepting with a time stages the same
 *     `book_appointment` pending action the voice agent uses. Calendar
 *     writes stay HITL — the owner approves before anything lands.
 */

type QuoteWithShop = QuoteRow & {
  shops: Pick<ShopRow, "id" | "name" | "phone" | "location" | "owner_id" | "voice_config"> | null
  customers: { id: string; name: string | null; phone: string | null; email: string | null } | null
  vehicles: { year: number | null; make: string | null; model: string | null; color: string | null } | null
}

export async function loadPublicQuote(token: string): Promise<QuoteWithShop | null> {
  if (!token || token.length < 16) return null
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("quotes")
    .select(
      "*, shops(id, name, phone, location, owner_id, voice_config), customers(id, name, phone, email), vehicles(year, make, model, color)"
    )
    .eq("public_token", token)
    .maybeSingle()
  const quote = data as QuoteWithShop | null
  if (!quote) return null

  // First view stamps viewed_at (+ status) and the timeline — quote
  // follow-up discipline runs off this.
  if (!quote.viewed_at && (quote.status === "sent" || quote.status === "viewed")) {
    const viewedAt = new Date().toISOString()
    await supabase
      .from("quotes")
      .update({
        viewed_at: viewedAt,
        status: quote.status === "sent" ? "viewed" : quote.status,
        updated_at: viewedAt,
      })
      .eq("id", quote.id)
    await recordInteraction(supabase, {
      shopId: quote.shop_id,
      customerId: quote.customer_id,
      channel: "note",
      role: "system",
      content: "Quote opened by the customer.",
      metadata: { kind: "quote", quote_id: quote.id, event: "viewed" },
    })
    quote.viewed_at = viewedAt
    if (quote.status === "sent") quote.status = "viewed"
  }
  return quote
}

export type QuoteResponseResult =
  | { ok: true; status: "accepted" | "declined"; bookingStaged: boolean }
  | { ok: false; error: string }

export async function respondToQuote(
  token: string,
  response: "accept" | "decline",
  preferredIsoTime?: string | null
): Promise<QuoteResponseResult> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("quotes")
    .select("*, shops(id, name, owner_id, voice_config), customers(id, name, phone, email)")
    .eq("public_token", token)
    .maybeSingle()
  const quote = data as QuoteWithShop | null
  if (!quote || !quote.shops) return { ok: false, error: "This quote link isn't valid." }
  if (!["sent", "viewed", "accepted"].includes(quote.status)) {
    return { ok: false, error: "This quote can't be responded to anymore." }
  }

  const now = new Date().toISOString()
  const nextStatus = response === "accept" ? "accepted" : "declined"
  await supabase
    .from("quotes")
    .update({ status: nextStatus, responded_at: quote.responded_at ?? now, updated_at: now })
    .eq("id", quote.id)

  await recordInteraction(supabase, {
    shopId: quote.shop_id,
    customerId: quote.customer_id,
    channel: "note",
    role: "customer",
    content:
      response === "accept"
        ? "Quote accepted by the customer."
        : "Quote declined by the customer.",
    metadata: { kind: "quote", quote_id: quote.id, event: nextStatus },
  })

  // Pipeline auto-move (C2, in code): decline → lost; accept keeps the card
  // hot (next_action_at = now) until the booking is approved → booked.
  if (quote.lead_id) {
    if (response === "decline") {
      await moveLeadToStage(supabase, quote.shop_id, quote.lead_id, "lost", {
        by: "system",
        lostReason: "other",
      })
    } else {
      const { error } = await supabase
        .from("leads")
        .update({ next_action_at: now })
        .eq("id", quote.lead_id)
        .eq("shop_id", quote.shop_id)
      if (error) console.warn("[quote-response] nudge skipped (pre-C1?):", error.message)
    }
  }

  if (response === "decline") {
    return { ok: true, status: "declined", bookingStaged: false }
  }

  // Book Now — stage the booking for owner approval when a time was picked.
  let bookingStaged = false
  const start = preferredIsoTime ? new Date(preferredIsoTime) : null
  if (start && !Number.isNaN(start.getTime()) && quote.customers?.phone) {
    const serviceNames = (quote.line_items ?? [])
      .map((li) => li.name)
      .filter(Boolean)
      .join(" + ")
    const { data: pending, error } = await supabase
      .from("pending_actions")
      .insert({
        shop_id: quote.shop_id,
        action_type: "book_appointment",
        payload: {
          customer_name: quote.customers.name ?? "Quote customer",
          phone: quote.customers.phone,
          car_info: null,
          service: serviceNames || "Quoted work",
          iso_start_time: start.toISOString(),
          duration_minutes: 120,
          timezone: null,
          email: quote.customers.email,
          pin_notes: `Booked from quote — total ${quote.total_cents / 100}`,
          source: "quote_page",
          quote_id: quote.id,
        },
        requested_by: quote.shops.owner_id,
      })
      .select("id")
      .single()
    if (!error && pending) bookingStaged = true
  }

  return { ok: true, status: "accepted", bookingStaged }
}
