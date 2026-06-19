import type { SupabaseClient } from "@supabase/supabase-js"

import { signatureLine } from "@/lib/persona"
import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"

/**
 * The ROI receipt — Gradia's weekly proof-of-value (FOCUS spec NOW-3).
 *
 * This is a TRUST ARTIFACT, so every number here traces to real rows and
 * under-claims by design. One inflated figure and the owner stops believing
 * all of them. The rules we hold to:
 *   - Counts come straight from the shop's own tables, scoped + windowed.
 *   - Money is "in play / tracked," never "earned." We only count a dollar
 *     when a booked appointment's service name matches a real service price.
 *     No match → it contributes $0. We never guess a quote.
 *   - Hours saved is an explicit, conservative per-action estimate (below),
 *     surfaced as "~N hrs" — honest about being a rule of thumb, not a clock.
 *
 * Collected revenue lives in RevenueTiles (the `payments` table). The receipt
 * deliberately shows pipeline ("in play"), a different and softer claim.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Conservative minutes-saved estimates per action. Deliberately low — we'd
 * rather the owner feel we under-counted than catch us padding. Surfaced as
 * "~N hrs" so it never reads as a precise measurement.
 */
export const SAVED_MINUTES = {
  /** Logging/structuring a lead instead of a sticky note. */
  lead: 2,
  /** Drafting + sending a reply or follow-up we'd otherwise hand-type. */
  message: 3,
  /** Securing a booking, net of the usual scheduling back-and-forth. */
  booking: 10,
} as const

export type RoiReceipt = {
  periodStart: string
  periodEnd: string
  /** Leads caught (new lead rows created this period). */
  leadsCaught: number
  /** Replies + follow-ups we sent for the owner (approved outbound). */
  messagesSent: number
  /** Bookings secured this period (each one was human-approved). */
  bookingsMade: number
  /** Booked service value we can actually trace to a real price. "In play." */
  moneyInPlayCents: number
  /** Leads that reached the 'recovered' revival state this period. */
  recoveredLeadsCount: number
  /** Conservative time-saved estimate, in whole minutes. */
  minutesSaved: number
  /** True when nothing happened yet — drives the written zero-state. */
  isEmpty: boolean
}

/** Outbound action types that count as "a message we sent for you." */
const OUTBOUND_TYPES = ["send_sms", "send_email"] as const

/**
 * Core compute. Takes an explicit client + shop so it serves both the in-app
 * render (RLS client via requireShop) and the weekly cron (service client).
 * Window is half-open [start, end). All four reads run in parallel.
 */
export async function computeRoiReceipt(
  supabase: SupabaseClient,
  shopId: string,
  start: Date,
  end: Date
): Promise<RoiReceipt> {
  const startIso = start.toISOString()
  const endIso = end.toISOString()

  const [leadsRes, messagesRes, apptRes, servicesRes, recoveredRes] =
    await Promise.all([
    // Leads caught — count only, no rows pulled.
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .gte("created_at", startIso)
      .lt("created_at", endIso),
    // Outbound we sent on the owner's behalf: approved send_sms/send_email,
    // decided (approved) within the window.
    supabase
      .from("pending_actions")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .in("action_type", OUTBOUND_TYPES as unknown as string[])
      .eq("status", "approved")
      .gte("decided_at", startIso)
      .lt("decided_at", endIso),
    // Bookings secured this period — each appointment row is a HITL-approved
    // booking. We pull service_name to price the pipeline below.
    supabase
      .from("appointments")
      .select("service_name")
      .eq("shop_id", shopId)
      .gte("created_at", startIso)
      .lt("created_at", endIso),
    // The shop's service menu — the only place a real dollar price lives.
    supabase
      .from("services")
      .select("name, price_cents")
      .eq("shop_id", shopId),
    // Leads revived this period. No per-status timestamp exists, so we
    // approximate the recovery moment with updated_at — close enough for the
    // weekly window and honest about being a rolling count, not an audit trail.
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .eq("lifecycle_status", "recovered")
      .gte("updated_at", startIso)
      .lt("updated_at", endIso),
  ])

  const leadsCaught = leadsRes.count ?? 0
  const messagesSent = messagesRes.count ?? 0
  const recoveredLeadsCount = recoveredRes.count ?? 0

  const appts =
    (apptRes.data as { service_name: string | null }[] | null) ?? []
  const bookingsMade = appts.length

  // Build a name→cents map (lowercased, trimmed) so we can price a booking by
  // its service name. A booking with no matching service contributes $0 — we
  // never invent a number we can't trace to a real price.
  const services =
    (servicesRes.data as { name: string; price_cents: number }[] | null) ?? []
  const priceByName = new Map<string, number>()
  for (const s of services) {
    const key = s.name?.trim().toLowerCase()
    if (key) priceByName.set(key, s.price_cents ?? 0)
  }

  let moneyInPlayCents = 0
  for (const a of appts) {
    const key = a.service_name?.trim().toLowerCase()
    if (key && priceByName.has(key)) {
      moneyInPlayCents += priceByName.get(key) ?? 0
    }
  }

  const minutesSaved =
    leadsCaught * SAVED_MINUTES.lead +
    messagesSent * SAVED_MINUTES.message +
    bookingsMade * SAVED_MINUTES.booking

  return {
    periodStart: startIso,
    periodEnd: endIso,
    leadsCaught,
    messagesSent,
    bookingsMade,
    moneyInPlayCents,
    recoveredLeadsCount,
    minutesSaved,
    isEmpty:
      leadsCaught === 0 &&
      messagesSent === 0 &&
      bookingsMade === 0 &&
      moneyInPlayCents === 0,
  }
}

/** Cents → "$1,200" (no trailing cents when whole, the common case). Shared by
 *  the Home card and the weekly SMS so the figure reads identically in both. */
export function formatReceiptDollars(cents: number): string {
  const dollars = cents / 100
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  })
}

/** Whole minutes → "~45 min" under an hour, else "~2.5 hrs". The "~" is
 *  load-bearing: this is an honest estimate, never a precise clock. */
export function formatReceiptHours(minutes: number): string {
  if (minutes < 60) return `~${minutes} min`
  const hrs = Math.round((minutes / 60) * 10) / 10
  return `~${hrs % 1 === 0 ? hrs.toFixed(0) : hrs.toFixed(1)} hrs`
}

/**
 * The weekly push copy — we/us voice, signed, conservative. Returns null for an
 * empty week (we never text "you did nothing" — that's anti-retention). Kept
 * pure + exported so it's unit-tested without a live send.
 */
export function composeReceiptSms(
  shopName: string,
  receipt: RoiReceipt
): string | null {
  if (receipt.isEmpty) return null
  const parts: string[] = []
  if (receipt.leadsCaught > 0) {
    parts.push(
      `${receipt.leadsCaught} ${receipt.leadsCaught === 1 ? "lead" : "leads"} caught`
    )
  }
  if (receipt.messagesSent > 0) {
    parts.push(
      `${receipt.messagesSent} ${receipt.messagesSent === 1 ? "reply" : "replies"} sent for you`
    )
  }
  if (receipt.bookingsMade > 0) {
    parts.push(
      `${receipt.bookingsMade} ${receipt.bookingsMade === 1 ? "booking" : "bookings"} secured`
    )
  }
  const headline = parts.join(", ")
  const money =
    receipt.moneyInPlayCents > 0
      ? ` ${formatReceiptDollars(receipt.moneyInPlayCents)} in booked work,`
      : ""
  return (
    `This week, together at ${shopName}: we got ${headline}.` +
    `${money} ${formatReceiptHours(receipt.minutesSaved)} of your time saved. ` +
    `Full receipt on your Gradia home.\n${signatureLine(shopName)}`
  )
}

/**
 * In-app render entry point: this week (rolling 7 days) for the current shop,
 * through the RLS client. Returns an empty receipt on query failure so Home
 * still renders its written zero-state rather than throwing.
 */
export async function getRoiReceiptForCurrentShop(): Promise<RoiReceipt> {
  const shop = await requireShop()
  const supabase = await createClient()
  const end = new Date()
  const start = new Date(end.getTime() - 7 * DAY_MS)
  try {
    return await computeRoiReceipt(supabase, shop.id, start, end)
  } catch (err) {
    console.error("[roi receipt] compute failed:", err)
    return {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      leadsCaught: 0,
      messagesSent: 0,
      bookingsMade: 0,
      moneyInPlayCents: 0,
      recoveredLeadsCount: 0,
      minutesSaved: 0,
      isEmpty: true,
    }
  }
}

/**
 * Cumulative "Found Money" — the all-time roll-up of the weekly snapshots the
 * cron persists into `shop_metrics`. Distinct from the live weekly receipt: this
 * is durable history, so it never recomputes and survives past the 7-day window.
 * Returns zeros on failure so the Home card still renders.
 */
export async function getFoundMoneyTotalForCurrentShop(): Promise<{
  foundMoneyCents: number
  recoveredLeads: number
}> {
  const shop = await requireShop()
  const supabase = await createClient()
  try {
    const { data, error } = await supabase
      .from("shop_metrics")
      .select("attributed_revenue_cents, recovered_leads_count")
      .eq("shop_id", shop.id)
    if (error) throw error
    const rows =
      (data as
        | { attributed_revenue_cents: number; recovered_leads_count: number }[]
        | null) ?? []
    return {
      foundMoneyCents: rows.reduce(
        (sum, r) => sum + (r.attributed_revenue_cents ?? 0),
        0
      ),
      recoveredLeads: rows.reduce(
        (sum, r) => sum + (r.recovered_leads_count ?? 0),
        0
      ),
    }
  } catch (err) {
    console.error("[roi receipt] found-money total failed:", err)
    return { foundMoneyCents: 0, recoveredLeads: 0 }
  }
}
