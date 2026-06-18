/**
 * Safe-send policy (B2) — the TCPA guardrails enforced in code at the SMS send
 * boundary (executeSendSms), so they hold no matter how the send was triggered
 * (owner approval OR an autonomous agent):
 *
 *   1. Quiet hours — never text into the recipient's overnight window. Uses the
 *      shop's timezone as the local-time proxy (customers are local to the shop).
 *   2. Opt-out — never text someone who said STOP (explicit timestamp).
 *   3. Marketing consent — a marketing/campaign text needs affirmative consent
 *      OR an established business relationship (a prior inbound from them). A
 *      transactional message (reply, reminder, confirmation) is exempt.
 *
 * All three FAIL CLOSED: when we can't establish it's safe, we hold the send.
 * Holding ≠ losing — the pending_action stays staged; the owner re-approves
 * during the day, or the next in-window autonomous run picks it up.
 */

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

type ConsentRow = Pick<CustomerConsentFields, "marketing_consent_at" | "sms_opted_out_at">
type CustomerConsentFields = {
  marketing_consent_at: string | null
  sms_opted_out_at: string | null
}

/** Loads a customer's consent state by id, else by phone. */
async function loadConsent(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string | null,
  phone: string | null
): Promise<{ row: ConsentRow | null; customerId: string | null }> {
  if (customerId) {
    const { data } = await supabase
      .from("customers")
      .select("id, marketing_consent_at, sms_opted_out_at")
      .eq("id", customerId)
      .maybeSingle()
    const row = data as (ConsentRow & { id: string }) | null
    return { row, customerId: row?.id ?? customerId }
  }
  if (phone) {
    const { data } = await supabase
      .from("customers")
      .select("id, marketing_consent_at, sms_opted_out_at")
      .eq("shop_id", shopId)
      .eq("phone", phone)
      .maybeSingle()
    const row = data as (ConsentRow & { id: string }) | null
    return { row, customerId: row?.id ?? null }
  }
  return { row: null, customerId: null }
}

/** True if the customer has ever sent us an inbound message (EBR proxy). */
async function hasInboundRelationship(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("interactions")
    .select("id")
    .eq("shop_id", shopId)
    .eq("customer_id", customerId)
    .eq("role", "customer")
    .limit(1)
  return Boolean((data as { id: string }[] | null)?.length)
}

/**
 * The send-time SMS gate. `nowMs` is injectable for tests.
 */
export async function evaluateSmsSendPolicy(
  supabase: SupabaseClient,
  shop: QuietConfig & { id: string },
  input: {
    toPhone: string
    customerId: string | null
    category: SendCategory
    nowMs?: number
  }
): Promise<SendDecision> {
  const now = input.nowMs ?? Date.now()

  // 1. Quiet hours — held (retry in-window), applies to every SMS.
  if (isQuietHours(now, shop.timezone, shop.quiet_hours_start, shop.quiet_hours_end)) {
    return {
      allowed: false,
      held: true,
      reason: `Held — it's outside texting hours (${shop.quiet_hours_end}:00–${shop.quiet_hours_start}:00 local). It'll send when you approve during the day.`,
    }
  }

  const { row, customerId } = await loadConsent(
    supabase,
    shop.id,
    input.customerId,
    input.toPhone
  )

  // 2. Opt-out — hard block, every category.
  if (row?.sms_opted_out_at) {
    return {
      allowed: false,
      held: false,
      reason: "This person texted STOP — we can't message them.",
    }
  }

  // 3. Marketing needs consent OR an established relationship.
  if (input.category === "marketing") {
    const consented = Boolean(row?.marketing_consent_at)
    const ebr = customerId
      ? await hasInboundRelationship(supabase, shop.id, customerId)
      : false
    if (!consented && !ebr) {
      return {
        allowed: false,
        held: false,
        reason:
          "Held — no marketing consent on file and no prior contact from them. Reach customers who opted in or who've messaged us.",
      }
    }
  }

  return { allowed: true }
}
