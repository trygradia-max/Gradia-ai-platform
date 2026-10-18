import type { SupabaseClient } from "@supabase/supabase-js"

import { normalizeDestination } from "@/lib/contact-destination"
import { durationSpread, resolveDurationMinutes } from "@/lib/service-pricing"
import type { ServiceRow, VehicleSizeClass } from "@/lib/types/database"

/**
 * How long a booking is, decided at the execution boundary (step 6: menu-
 * grounded duration). A model's or an API caller's duration is never trusted
 * where the menu has authority:
 *
 *   - owner     the owner set the length on the card (Approvals editor): a
 *               human decision, used as given.
 *   - quote     staged by quote acceptance, which already summed the shop's
 *               menu durations server-side (#76).
 *   - menu      everything else (voice, MCP, the owner agent): the one menu
 *               service named, sized to the customer's vehicle when its
 *               duration varies by size.
 *
 * When the menu cannot decide, the booking is held for the owner instead of
 * guessed: no service named or none matching, several matching, or a size-
 * dependent duration with no single known vehicle size.
 */
export type BookingDuration =
  | { ok: true; minutes: number; source: "owner" | "quote" | "menu"; serviceName?: string }
  | { ok: false; reason: "service_unmatched" | "service_ambiguous" | "vehicle_size_unknown" | "menu_unavailable" }

type DurationProposal = {
  service?: string | null
  phone?: string | null
  duration_minutes?: unknown
  duration_source?: unknown
  quote_id?: unknown
}

type MenuService = Pick<ServiceRow, "id" | "name" | "duration_minutes" | "duration_by_size">

const validMinutes = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 24 * 60

/** Exact name first (case- and space-insensitive), then one-way containment. */
export function matchMenuService(services: MenuService[], requested: string | null | undefined): MenuService[] {
  const q = (requested ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  if (!q) return []
  const name = (s: MenuService) => s.name.trim().toLowerCase().replace(/\s+/g, " ")
  const exact = services.filter((s) => name(s) === q)
  if (exact.length > 0) return exact
  return services.filter((s) => name(s).includes(q) || q.includes(name(s)))
}

/** True when an unknown vehicle size could change this service's length. */
export function durationDependsOnSize(service: Pick<ServiceRow, "duration_minutes" | "duration_by_size">): boolean {
  const spread = durationSpread(service)
  return spread !== null && (spread.low !== spread.high || spread.low !== service.duration_minutes)
}

export async function resolveBookingDuration(
  supabase: SupabaseClient,
  shopId: string,
  proposal: DurationProposal
): Promise<BookingDuration> {
  if (proposal.duration_source === "owner" && validMinutes(proposal.duration_minutes)) {
    return { ok: true, minutes: proposal.duration_minutes, source: "owner" }
  }
  if (
    typeof proposal.quote_id === "string" && proposal.quote_id &&
    (proposal.duration_source === "menu" || proposal.duration_source === "default") &&
    validMinutes(proposal.duration_minutes)
  ) {
    return { ok: true, minutes: proposal.duration_minutes, source: "quote" }
  }

  const { data, error } = await supabase
    .from("services")
    .select("id, name, duration_minutes, duration_by_size")
    .eq("shop_id", shopId)
  if (error) return { ok: false, reason: "menu_unavailable" }
  const matches = matchMenuService((data as MenuService[] | null) ?? [], proposal.service)
  if (matches.length === 0) return { ok: false, reason: "service_unmatched" }
  if (matches.length > 1) return { ok: false, reason: "service_ambiguous" }
  const service = matches[0]

  let size: VehicleSizeClass | null = null
  if (durationDependsOnSize(service)) {
    size = await knownVehicleSize(supabase, shopId, proposal.phone)
    if (!size) return { ok: false, reason: "vehicle_size_unknown" }
  }
  return { ok: true, minutes: resolveDurationMinutes(service, size), source: "menu", serviceName: service.name }
}

/** The one size class on file for this phone's customer, if exactly one is known. */
async function knownVehicleSize(
  supabase: SupabaseClient,
  shopId: string,
  phone: string | null | undefined
): Promise<VehicleSizeClass | null> {
  const canonical = phone ? normalizeDestination("sms", phone) : null
  if (!canonical) return null
  const { data: customer } = await supabase
    .from("customers")
    .select("id")
    .eq("shop_id", shopId)
    .eq("phone_canonical", canonical)
    .maybeSingle()
  const customerId = (customer as { id: string } | null)?.id
  if (!customerId) return null
  const { data: vehicles } = await supabase
    .from("vehicles")
    .select("size_class")
    .eq("shop_id", shopId)
    .eq("customer_id", customerId)
    .not("size_class", "is", null)
  const sizes = new Set(((vehicles as { size_class: VehicleSizeClass }[] | null) ?? []).map((v) => v.size_class))
  return sizes.size === 1 ? [...sizes][0] : null
}

/** Owner-facing hold text for a booking whose length the menu could not decide. */
export function bookingDurationHold(reason: Extract<BookingDuration, { ok: false }>["reason"], service: string | null | undefined): string {
  const named = service?.trim() ? `"${service.trim()}"` : "This booking"
  switch (reason) {
    case "service_unmatched":
      return `Held — ${named} doesn't match a service on your menu, so Gradia can't tell how long to book. Edit the card to set the service or length, then approve.`
    case "service_ambiguous":
      return `Held — ${named} matches more than one service on your menu. Edit the card to pick the length, then approve.`
    case "vehicle_size_unknown":
      return `Held — how long ${named} takes depends on vehicle size, and this customer's vehicle size isn't known. Edit the card to set the length, then approve.`
    case "menu_unavailable":
      return "Held — couldn't read your service menu to size this booking. Nothing was booked; try again shortly."
  }
}
