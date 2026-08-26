"use server"

import { stagingAvailability } from "@/lib/availability"
import { recordInteraction } from "@/lib/memory"
import { moveLeadToStage } from "@/lib/pipeline"
import { isQuoteExpired } from "@/lib/quotes"
import { checkRateLimit } from "@/lib/rate-limit"
import { STRINGS } from "@/lib/strings"
import { createServiceClient } from "@/lib/supabase/service"
import type { QuoteRow, ShopRow } from "@/lib/types/database"

/**
 * Public quote responses (CRM C3b) — the /q/[token] page's actions. The
 * token IS the auth (128-bit, unguessable, single quote scope); everything
 * runs under the service client with shop_id taken from the quote row.
 * No public request field is ever trusted for tenant linkage — the quote
 * row resolves shop/customer/lead server-side (P0-009).
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

/** Has THIS quote already staged its booking approval? (Replay echo +
 *  exactly-once staging evidence; shop-scoped.) */
async function hasStagedQuoteBooking(
  supabase: ReturnType<typeof createServiceClient>,
  shopId: string,
  quoteId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("pending_actions")
    .select("id")
    .eq("shop_id", shopId)
    .eq("action_type", "book_appointment")
    .eq("payload->>quote_id", quoteId)
    .limit(1)
  return ((data as { id: string }[] | null)?.length ?? 0) > 0
}

export async function respondToQuote(
  token: string,
  response: "accept" | "decline",
  preferredIsoTime?: string | null
): Promise<QuoteResponseResult> {
  // Same token sanity-check as loadPublicQuote (L-3 parity, P0-009).
  if (!token || token.length < 16) {
    return { ok: false, error: STRINGS.quotePublic.invalidLink }
  }
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("quotes")
    .select("*, shops(id, name, owner_id, voice_config), customers(id, name, phone, email)")
    .eq("public_token", token)
    .maybeSingle()
  const quote = data as QuoteWithShop | null
  if (!quote || !quote.shops) return { ok: false, error: STRINGS.quotePublic.invalidLink }

  // Burst guard on the public money surface (P0-009). Fail-open by design
  // (lib/rate-limit.ts) — a limiter outage never blocks a real customer.
  const limit = await checkRateLimit(quote.shop_id, "quote_response")
  if (!limit.allowed) {
    console.warn(
      `[quote-response] rate limited — shop ${quote.shop_id} quote ${quote.id}`
    )
    return { ok: false, error: STRINGS.quotePublic.rateLimited }
  }

  // Server-enforced expiry at the mutation boundary (P0-009): a stale tab
  // opened before expiry cannot accept (or decline) a dead price. Zero side
  // effects on refusal. Expiry binds at the CUSTOMER-facing moment only — an
  // owner approving an already-accepted quote's booking is not re-gated.
  if (isQuoteExpired(quote.valid_until)) {
    console.warn(
      `[quote-response] expired ${response} refused — quote ${quote.id} shop ${quote.shop_id} valid_until ${quote.valid_until}`
    )
    return { ok: false, error: STRINGS.quotePublic.expiredRefusal }
  }

  const nextStatus = response === "accept" ? "accepted" : "declined"

  // Replay echo: a double-click / stale tab repeating the SAME response is
  // harmless — report the standing state, mutate nothing, stage nothing.
  if (quote.status === nextStatus) {
    const bookingStaged =
      response === "accept" &&
      (await hasStagedQuoteBooking(supabase, quote.shop_id, quote.id))
    return { ok: true, status: nextStatus, bookingStaged }
  }
  if (quote.status !== "sent" && quote.status !== "viewed") {
    return { ok: false, error: STRINGS.quotePublic.alreadyDecided }
  }

  // Atomic transition claim: only the request that actually flips
  // sent/viewed → accepted/declined runs the side effects below, so a
  // concurrent double-submit can never stage two booking cards.
  const now = new Date().toISOString()
  const { data: claimedRows, error: claimErr } = await supabase
    .from("quotes")
    .update({ status: nextStatus, responded_at: quote.responded_at ?? now, updated_at: now })
    .eq("id", quote.id)
    .eq("shop_id", quote.shop_id)
    .in("status", ["sent", "viewed"])
    .select("id")
  if (claimErr) {
    console.error(
      `[quote-response] status update failed — quote ${quote.id} shop ${quote.shop_id}: ${claimErr.message}`
    )
    return { ok: false, error: STRINGS.quotePublic.saveFailed }
  }
  if (!claimedRows || claimedRows.length === 0) {
    // Lost a race — echo whatever actually landed.
    const { data: current } = await supabase
      .from("quotes")
      .select("status")
      .eq("id", quote.id)
      .maybeSingle()
    const landed = (current as { status: QuoteRow["status"] } | null)?.status
    if (landed === nextStatus) {
      const bookingStaged =
        response === "accept" &&
        (await hasStagedQuoteBooking(supabase, quote.shop_id, quote.id))
      return { ok: true, status: nextStatus, bookingStaged }
    }
    return { ok: false, error: STRINGS.quotePublic.alreadyDecided }
  }

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
  let stagingIssue: "no_phone" | "staging_failed" | null = null
  const start = preferredIsoTime ? new Date(preferredIsoTime) : null
  if (start && !Number.isNaN(start.getTime())) {
    if (!quote.customers?.phone) {
      stagingIssue = "no_phone"
    } else {
      const serviceNames = (quote.line_items ?? [])
        .map((li) => li.name)
        .filter(Boolean)
        .join(" + ")
      // P0-004 advisory snapshot: the customer picked this time, the owner
      // decides — the card shows any conflict, and the executor re-checks
      // authoritatively at approve time.
      const availability = await stagingAvailability(supabase, quote.shop_id, {
        start,
        end: new Date(start.getTime() + 120 * 60_000),
        path: "stage:quote_accept",
      })
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
            // P0-009: server-resolved refs the executor re-validates
            // (shop-scoped) to reuse the quote's EXISTING lead.
            quote_id: quote.id,
            lead_id: quote.lead_id,
            ...(availability.summary ? { availability: availability.summary } : {}),
          },
          requested_by: quote.shops.owner_id,
        })
        .select("id")
        .single()
      if (!error && pending) bookingStaged = true
      else stagingIssue = "staging_failed"
      if (error) {
        console.error(
          `[quote-response] booking staging failed — quote ${quote.id} shop ${quote.shop_id}: ${error.message}`
        )
      }
    }
  }

  // P0-009: never a silent drop — the customer accepted and asked for a
  // time we could not stage; the owner learns it from the timeline.
  if (stagingIssue) {
    console.warn(
      `[quote-response] acceptance without booking (${stagingIssue}) — quote ${quote.id} shop ${quote.shop_id}`
    )
    await recordInteraction(supabase, {
      shopId: quote.shop_id,
      customerId: quote.customer_id,
      channel: "note",
      role: "system",
      content:
        stagingIssue === "no_phone"
          ? `Customer accepted and asked for ${start?.toISOString()}, but no phone is on file — no booking was staged. Reach out to schedule.`
          : `Customer accepted and asked for ${start?.toISOString()}, but staging the booking failed — no booking was staged. Reach out to schedule.`,
      metadata: {
        kind: "quote",
        quote_id: quote.id,
        event: "accepted_no_booking",
        reason: stagingIssue,
      },
    })
  }

  return { ok: true, status: "accepted", bookingStaged }
}
