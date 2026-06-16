/**
 * Credit metering — the single source for what an action costs and whether a
 * shop has hit its cap.
 *
 * Credits are denominated as ~1¢ of API cost (see the cost model): a message
 * or agent run is 1 credit, a voice minute ~15. These defaults are tunable —
 * change CREDIT_COST here.
 *
 * Spend is DERIVED from the usage_events ledger since shops.credit_period_start
 * — there's no cached balance to drift. recordUsage is best-effort and never
 * throws into a caller's critical path; metering must not break a send.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { isPaid } from "@/lib/entitlements"
import { FEATURES } from "@/lib/features"
import { PLAN } from "@/lib/pricing"
import type { ShopRow, UsageEventKind } from "@/lib/types/database"

/**
 * Credits per unit of the legacy LLM-era kinds — kept only so historical
 * rows stay interpretable. ALL new writers price through lib/pricing.ts
 * (the locked menu) and pass explicit values to recordUsage.
 */
export const CREDIT_COST: Partial<Record<UsageEventKind, number>> = {
  agent_run: 1,
  message: 1,
  voice_minute: 15,
}

export function creditsFor(kind: UsageEventKind, quantity = 1): number {
  return (CREDIT_COST[kind] ?? 0) * Math.max(0, Math.round(quantity))
}

type ShopCreditFields = Pick<ShopRow, "id" | "plan" | "credit_period_start">

/**
 * Append a usage event. Best-effort — logs and swallows errors so metering
 * never breaks the action it's measuring.
 */
export async function recordUsage(
  supabase: SupabaseClient,
  shopId: string,
  kind: UsageEventKind,
  opts?: {
    quantity?: number
    refId?: string | null
    /** Explicit priced values from lib/pricing.ts (telephony kinds). When
     * `credits` is omitted the legacy CREDIT_COST table applies. */
    credits?: number
    wholesaleCost?: number
    retailCost?: number
    /** Twilio/Vapi record id for the nightly reconciliation job. */
    vendorRef?: string | null
  }
): Promise<void> {
  const quantity = opts?.quantity ?? 1
  try {
    const { error } = await supabase.from("usage_events").insert({
      shop_id: shopId,
      kind,
      quantity,
      credits: opts?.credits ?? creditsFor(kind, quantity),
      wholesale_cost: opts?.wholesaleCost ?? null,
      retail_cost: opts?.retailCost ?? null,
      vendor_ref: opts?.vendorRef ?? null,
      ref_id: opts?.refId ?? null,
    })
    if (error) console.error("[credits] recordUsage failed:", error)
  } catch (err) {
    console.error("[credits] recordUsage threw:", err)
  }
}

/** Credits spent in the current period (since shop.credit_period_start). */
export async function creditsSpentThisPeriod(
  supabase: SupabaseClient,
  shop: Pick<ShopRow, "id" | "credit_period_start">
): Promise<number> {
  const { data, error } = await supabase
    .from("usage_events")
    .select("credits")
    .eq("shop_id", shop.id)
    .gte("created_at", shop.credit_period_start)
  if (error) {
    console.error("[credits] spend query failed:", error)
    return 0
  }
  return ((data as { credits: number }[] | null) ?? []).reduce(
    (sum, r) => sum + (r.credits ?? 0),
    0
  )
}

/** Credits granted (pack purchases + rollover) since credit_period_start. */
export async function creditsGrantedThisPeriod(
  supabase: SupabaseClient,
  shop: Pick<ShopRow, "id" | "credit_period_start">
): Promise<number> {
  const { data, error } = await supabase
    .from("credit_grants")
    .select("credits")
    .eq("shop_id", shop.id)
    .gte("created_at", shop.credit_period_start)
  if (error) {
    console.error("[credits] grants query failed:", error)
    return 0
  }
  return ((data as { credits: number }[] | null) ?? []).reduce(
    (sum, r) => sum + (r.credits ?? 0),
    0
  )
}

/**
 * The shop's credit allowance this period (GRADIA_PRICING.md):
 * plan-included credits (Core = 1,200 while the subscription is active)
 * plus pack purchases and rollover grants since credit_period_start.
 * The cap IS the allowance; fail closed past it.
 */
export async function creditAllowanceThisPeriod(
  supabase: SupabaseClient,
  shop: ShopCreditFields
): Promise<number> {
  const included = shop.plan === "active" ? PLAN.CORE_INCLUDED_CREDITS : 0
  return included + (await creditsGrantedThisPeriod(supabase, shop))
}

export async function remainingCredits(
  supabase: SupabaseClient,
  shop: ShopCreditFields
): Promise<number> {
  const [allowance, spent] = await Promise.all([
    creditAllowanceThisPeriod(supabase, shop),
    creditsSpentThisPeriod(supabase, shop),
  ])
  return Math.max(0, allowance - spent)
}

/**
 * True when the shop has spent its allowance. The runtime fails closed
 * (stages nothing) and the owner is offered a credit pack.
 */
export async function isOverCreditLimit(
  supabase: SupabaseClient,
  shop: ShopCreditFields
): Promise<boolean> {
  const [allowance, spent] = await Promise.all([
    creditAllowanceThisPeriod(supabase, shop),
    creditsSpentThisPeriod(supabase, shop),
  ])
  return spent >= allowance
}

export type CreditPrecheck =
  | { ok: true; remaining: number }
  | { ok: false; remaining: number; reason: string }

/**
 * Pre-check BEFORE consuming a metered resource: would spending `cost`
 * credits stay within the cap? Callers must run this before the vendor call
 * (Twilio purchase, outbound send, voice session), not after — the cap must
 * prevent the spend, not report it. A ledger read error fails open like the
 * rest of this module (metering must never break the product), but a real
 * over-cap answer is a hard stop.
 */
export async function precheckCredits(
  supabase: SupabaseClient,
  shop: ShopCreditFields,
  cost: number
): Promise<CreditPrecheck> {
  const remaining = await remainingCredits(supabase, shop)
  if (cost > remaining) {
    return {
      ok: false,
      remaining,
      reason: `This needs ${cost} credits but only ${remaining} remain this period. Add a credit pack ($10 / 950 credits) in Billing to keep going.`,
    }
  }
  return { ok: true, remaining }
}

/**
 * Loads the credit/plan fields for a shop id (RLS-scoped to the caller's
 * client). Routes hold a lightweight {id,name} ShopContext; this fetches what
 * the credit gate needs. Returns null if the row isn't visible/owned.
 */
export async function loadShopCreditFields(
  supabase: SupabaseClient,
  shopId: string
): Promise<ShopCreditFields | null> {
  const { data, error } = await supabase
    .from("shops")
    .select("id, plan, credit_period_start")
    .eq("id", shopId)
    .maybeSingle()
  if (error || !data) return null
  return data as ShopCreditFields
}

export type AutoTopupCheck =
  | { allowed: true; ceilingRemaining: number | null }
  | { allowed: false; ceilingRemaining: number; reason: string }

/**
 * Auto-top-up ceiling (GRADIA_PRICING.md). `shops.credit_limit` is the
 * owner-set MONTHLY cap on AUTOMATIC credit purchases — the runaway-spend
 * backstop for Package 2 autonomy. 0 / unset means no ceiling.
 *
 * Any auto-top-up flow MUST call this before granting credits, so a stuck
 * autonomous agent can never infinitely rebuy and bill the owner's card.
 * Manual, owner-initiated pack purchases are intentionally NOT gated here —
 * the owner is in the loop for those.
 */
export async function checkAutoTopupAllowed(
  supabase: SupabaseClient,
  shop: Pick<ShopRow, "id" | "credit_period_start" | "credit_limit">,
  packCredits: number
): Promise<AutoTopupCheck> {
  const ceiling = shop.credit_limit ?? 0
  if (ceiling <= 0) return { allowed: true, ceilingRemaining: null }
  const grantedSoFar = await creditsGrantedThisPeriod(supabase, shop)
  const ceilingRemaining = Math.max(0, ceiling - grantedSoFar)
  if (packCredits > ceilingRemaining) {
    return {
      allowed: false,
      ceilingRemaining,
      reason: `Auto-top-up would pass your monthly ceiling of ${ceiling} credits (${grantedSoFar} already added this period). Raise it in Billing to allow more.`,
    }
  }
  return { allowed: true, ceilingRemaining }
}

export type FeatureAccess =
  | { ok: true }
  | { ok: false; status: number; reason: string }

/**
 * Hard gate for owner-initiated metered surfaces — Gradia Agent, Gradia
 * Whisper, Ask Gradia, and any future feature that consumes credits. Call it
 * at the entry of the route, BEFORE doing any work.
 *
 * Fail-closed in two ways: an inactive plan (`free`/`past_due`) or an
 * exhausted credit allowance both shut the feature off until the owner
 * reactivates or buys a pack. Returns ok when the paywall flag is off so the
 * gate stays reversible (gate, don't delete). 402 = Payment Required.
 */
export async function checkFeatureAccess(
  supabase: SupabaseClient,
  shop: ShopCreditFields
): Promise<FeatureAccess> {
  if (!FEATURES.paywall) return { ok: true }
  if (!isPaid(shop)) {
    return {
      ok: false,
      status: 402,
      reason:
        "Your Gradia plan is inactive. Reactivate it in Billing to switch Gradia Agent and Whisper back on.",
    }
  }
  if (await isOverCreditLimit(supabase, shop)) {
    return {
      ok: false,
      status: 402,
      reason:
        "You're out of credits for this period. Add a credit pack ($10 / 950 credits) in Billing to switch everything back on.",
    }
  }
  return { ok: true }
}
