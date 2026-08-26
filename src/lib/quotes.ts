/**
 * Quotes (CRM C3) — the money object. Pure builders here; DB writes live in
 * the server actions / approvals executor. Every price comes through
 * lib/service-pricing (locked §C1.6), so the quote builder, the voice
 * receptionist, and Whisper can never disagree on a number.
 *
 * Provenance rule (locked): quotes created by the agent are ALWAYS `draft` —
 * created via the create_quote pending action (ALWAYS_HITL), never sent by
 * anything but an explicit owner action.
 */

import {
  applyConditionMultipliers,
  formatPriceUsd,
  resolveDurationMinutes,
  resolvePriceCents,
  type ServicePriceFields,
} from "@/lib/service-pricing"
import type {
  QuoteLineItem,
  ServiceRow,
  VehicleSizeClass,
} from "@/lib/types/database"

export type QuotableService = Pick<ServiceRow, "id" | "name"> &
  ServicePriceFields &
  Partial<Pick<ServiceRow, "duration_minutes" | "duration_by_size">>

/**
 * One line item, priced through the shared module: size-class base, then
 * the selected condition multipliers. `modifiers` records the multiplier
 * keys so the line is auditable ("why is this $375?").
 */
export function buildQuoteLineItem(
  service: QuotableService,
  sizeClass: VehicleSizeClass | null,
  multiplierKeys: string[] = []
): QuoteLineItem {
  const base = resolvePriceCents(service, sizeClass)
  const price = applyConditionMultipliers(base, service, multiplierKeys)
  return {
    service_id: service.id,
    name: service.name,
    base_cents: base,
    modifiers: multiplierKeys,
    price_cents: price,
  }
}

export function computeQuoteTotals(
  lineItems: QuoteLineItem[],
  discountCents = 0
): { subtotal_cents: number; discount_cents: number; total_cents: number } {
  const subtotal = lineItems.reduce((sum, li) => sum + (li.price_cents || 0), 0)
  const discount = Math.max(0, Math.min(Math.round(discountCents), subtotal))
  return {
    subtotal_cents: subtotal,
    discount_cents: discount,
    total_cents: subtotal - discount,
  }
}

/** Estimated duration for the quoted work (for the public page). */
export function quoteDurationMinutes(
  services: QuotableService[],
  sizeClass: VehicleSizeClass | null
): number {
  return services.reduce(
    (sum, s) =>
      sum +
      (s.duration_minutes != null
        ? resolveDurationMinutes(
            { duration_minutes: s.duration_minutes, duration_by_size: s.duration_by_size },
            sizeClass
          )
        : 0),
    0
  )
}

/** The outbound SMS body for a sent quote — deterministic, we/us, signed
 *  by the send path. Keep it short: one price, one link. */
export function quoteSmsBody(input: {
  shopName: string
  customerName: string | null
  totalCents: number
  url: string
}): string {
  const first = input.customerName?.trim().split(/\s+/)[0]
  const hi = first ? `Hi ${first} — ` : ""
  return `${hi}here's your quote from ${input.shopName}: ${formatPriceUsd(input.totalCents)}. Full details and booking: ${input.url}`
}

/** Email counterpart (fallback while SMS pends A2P). */
export function quoteEmailBody(input: {
  shopName: string
  customerName: string | null
  totalCents: number
  url: string
  validUntil: string | null
}): { subject: string; body: string } {
  const first = input.customerName?.trim().split(/\s+/)[0]
  const validity = input.validUntil
    ? `\n\nThis quote is good through ${input.validUntil}.`
    : ""
  return {
    subject: `Your quote from ${input.shopName} — ${formatPriceUsd(input.totalCents)}`,
    body: `${first ? `Hi ${first},` : "Hi,"}\n\nWe put together your quote: ${formatPriceUsd(input.totalCents)}.\n\nSee the line items and book a time here: ${input.url}${validity}`,
  }
}

/** Public quote URL for a token (relative base resolved by the caller). */
export function quotePath(publicToken: string): string {
  return `/q/${publicToken}`
}

/**
 * P0-009 — the one expiry rule, shared by the public page (display) and
 * respondToQuote (server enforcement) so they can never disagree.
 * `valid_until` is a DATE column ("Good through {date}"): the quote stays
 * acceptable through the WHOLE of that day, UTC; it expires at the first
 * instant of the next day. Null (and unreadable values) never expire —
 * non-expiring quotes must not be locked out.
 */
export function isQuoteExpired(
  validUntil: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!validUntil) return false
  const end = /^\d{4}-\d{2}-\d{2}$/.test(validUntil)
    ? Date.parse(`${validUntil}T23:59:59.999Z`)
    : Date.parse(validUntil)
  if (Number.isNaN(end)) return false
  return now.getTime() > end
}
