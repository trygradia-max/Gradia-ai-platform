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

/**
 * The shop's credit allowance this period (GRADIA_PRICING.md):
 * plan-included credits (Core = 1,200 while the subscription is active)
 * plus pack purchases and rollover grants since credit_period_start.
 * shops.credit_limit no longer caps spend — it's reserved for the future
 * auto-top-up ceiling. The cap IS the allowance; fail closed past it.
 */
export async function creditAllowanceThisPeriod(
  supabase: SupabaseClient,
  shop: ShopCreditFields
): Promise<number> {
  const included = shop.plan === "active" ? PLAN.CORE_INCLUDED_CREDITS : 0
  const { data, error } = await supabase
    .from("credit_grants")
    .select("credits")
    .eq("shop_id", shop.id)
    .gte("created_at", shop.credit_period_start)
  if (error) {
    console.error("[credits] grants query failed:", error)
    return included
  }
  const granted = ((data as { credits: number }[] | null) ?? []).reduce(
    (sum, r) => sum + (r.credits ?? 0),
    0
  )
  return included + granted
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
