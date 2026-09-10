/**
 * Safe-send policy (B2) — the TCPA guardrails enforced in code at the SMS send
 * boundary (executeSendSms), so they hold no matter how the send was triggered
 * (owner approval OR an autonomous agent):
 *
 *   1. Quiet hours — never text into the recipient's overnight window. Uses the
 *      shop's timezone as the local-time proxy (customers are local to the shop).
 *   2. Opt-out — never text someone who said STOP (explicit timestamp).
 *   3. Marketing consent — a marketing/campaign text needs affirmative channel- and destination-bound consent. A
 *      transactional message (reply, reminder, confirmation) is exempt.
 *
 * All three FAIL CLOSED: when we can't establish it's safe, we hold the send.
 * Holding ≠ losing — the pending_action stays staged; the owner re-approves
 * during the day, or the next in-window autonomous run picks it up.
 */

import { normalizeDestination } from "@/lib/contact-destination"
export { normalizeDestination } from "@/lib/contact-destination"
import { verifyServiceProof } from "@/lib/service-purpose"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { ShopRow } from "@/lib/types/database"

export type SendCategory = "marketing" | "transactional"

export type SendDecision =
  | { allowed: true }
  | { allowed: false; held: boolean; reason: string }

type QuietConfig = Pick<
  ShopRow,
  "timezone" | "quiet_hours_start" | "quiet_hours_end"
>

/** Local hour (0–23) in a timezone for a given instant. */
function localHour(nowMs: number, timezone: string): number {
  try {
    const hh = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(nowMs))
    return Number.parseInt(hh, 10)
  } catch {
    // Bad timezone string → fall back to UTC rather than throwing in a send.
    return new Date(nowMs).getUTCHours()
  }
}

/**
 * True when `nowMs` falls inside the shop's quiet window. Windows wrap midnight
 * (start 21, end 8 ⇒ quiet from 9pm through 8am).
 */
export function isQuietHours(
  nowMs: number,
  timezone: string,
  startHour: number,
  endHour: number
): boolean {
  const hour = localHour(nowMs, timezone)
  if (startHour === endHour) return false // empty window
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour
}

export type CustomerSendInput = {
  channel: "sms" | "email"
  destination: string
  customerId: string | null
  category: SendCategory | undefined
  nowMs?: number
  body?: string
  subject?: string
  serviceProof?: string | null
}

type Recipient = {
  id: string
  shop_id: string
  phone: string | null
  email: string | null
  do_not_contact: boolean
  sms_opted_out_at: string | null
}

export type CustomerSendDecision =
  | { allowed: true; customerId: string; destination: string }
  | { allowed: false; held: boolean; reason: string }

function denied(reason: string): CustomerSendDecision {
  return { allowed: false, held: true, reason: `Held for review — ${reason}` }
}

/** Shared send-time boundary. A failed/ambiguous read never grants permission.
 * Channel permissions are bound to the current destination; old generic consent
 * and unrelated inbound interactions cannot grant marketing permission.
 */
export async function evaluateCustomerSendPolicy(
  supabase: SupabaseClient,
  shop: QuietConfig & { id: string },
  input: CustomerSendInput
): Promise<CustomerSendDecision> {
  const destination = normalizeDestination(input.channel, input.destination)
  if (!destination) return denied("Invalid recipient destination.")
  if (input.category !== "transactional" && input.category !== "marketing") {
    return denied("Message category must be explicitly classified before sending.")
  }
  try {
    let query = supabase.from("customers")
      .select("id, shop_id, phone, email, do_not_contact, sms_opted_out_at")
      .eq("shop_id", shop.id)
    query = input.customerId ? query.eq("id", input.customerId) : query.eq(input.channel === "sms" ? "phone_canonical" : "email_canonical", destination)
    const { data, error } = await query.maybeSingle()
    const customer = data as Recipient | null
    if (error || !customer || customer.shop_id !== shop.id ||
        (input.customerId && customer.id !== input.customerId)) return denied("Recipient could not be verified for this shop.")
    if (normalizeDestination(input.channel, (input.channel === "sms" ? customer.phone : customer.email) ?? "") !== destination) {
      return denied("Destination does not belong to the referenced customer.")
    }
    if (customer.do_not_contact !== false) return denied("Customer is marked do not contact, or contact permission is unknown.")
    if (input.channel === "sms" && customer.sms_opted_out_at !== null) return denied("This person texted STOP, or SMS opt-out state is unknown.")
    const { data: permission, error: permissionError } = await supabase.from("customer_channel_permissions")
      .select("shop_id, customer_id, channel, destination, suppressed_at, marketing_consent_at")
      .eq("shop_id", shop.id).eq("customer_id", customer.id)
      .eq("channel", input.channel).eq("destination", destination).maybeSingle()
    if (permissionError) return denied("Channel permission lookup failed.")
    const row = permission as { shop_id: string; customer_id: string; channel: string; destination: string; suppressed_at: string | null; marketing_consent_at: string | null } | null
    if (row && (row.shop_id !== shop.id || row.customer_id !== customer.id || row.channel !== input.channel || row.destination !== destination)) return denied("Channel permission does not match recipient.")
    if (row && row.suppressed_at !== null) return denied("This destination is suppressed for this channel.")
    if (input.category === "marketing" && !row?.marketing_consent_at) return denied("No affirmative consent for marketing on this channel and destination.")
    if (input.category === "transactional" && !await verifyServiceProof(supabase,{shopId:shop.id,customerId:customer.id,channel:input.channel,destination,body:input.body??"",subject:input.subject},input.serviceProof)) return denied("Service purpose could not be verified. Reclassify this message or open its verified conversation.")
    if (input.channel === "sms") {
      if (!shop.timezone || !Number.isInteger(shop.quiet_hours_start) || !Number.isInteger(shop.quiet_hours_end) || shop.quiet_hours_start < 0 || shop.quiet_hours_start > 23 || shop.quiet_hours_end < 0 || shop.quiet_hours_end > 23) return denied("Texting hours could not be verified.")
      try { new Intl.DateTimeFormat("en", { timeZone: shop.timezone }).format() } catch { return denied("Texting timezone could not be verified.") }
      if (isQuietHours(input.nowMs ?? Date.now(), shop.timezone, shop.quiet_hours_start, shop.quiet_hours_end)) {
        return { allowed: false, held: true, reason: "Held — outside permitted texting hours." }
      }
    }
    return { allowed: true, customerId: customer.id, destination }
  } catch {
    return denied("Recipient or channel permission lookup failed.")
  }
}

export async function evaluateSmsSendPolicy(
  supabase: SupabaseClient,
  shop: QuietConfig & { id: string },
  input: { toPhone: string; customerId: string | null; category: SendCategory | undefined; nowMs?: number; body?: string; serviceProof?: string | null }
): Promise<CustomerSendDecision> {
  return evaluateCustomerSendPolicy(supabase, shop, { ...input, channel: "sms", destination: input.toPhone })
}
