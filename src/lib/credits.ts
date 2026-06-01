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

import type { ShopRow, UsageEventKind } from "@/lib/types/database"

/** Credits per unit of each metered action. ~1 credit ≈ 1¢ of API cost. */
export const CREDIT_COST: Record<UsageEventKind, number> = {
  agent_run: 1,
  message: 1,
  voice_minute: 15,
}

export function creditsFor(kind: UsageEventKind, quantity = 1): number {
  return CREDIT_COST[kind] * Math.max(0, Math.round(quantity))
}

type ShopCreditFields = Pick<
  ShopRow,
  "id" | "credit_period_start" | "credit_limit"
>

/**
 * Append a usage event. Best-effort — logs and swallows errors so metering
 * never breaks the action it's measuring.
 */
export async function recordUsage(
  supabase: SupabaseClient,
  shopId: string,
  kind: UsageEventKind,
  opts?: { quantity?: number; refId?: string | null }
): Promise<void> {
  const quantity = opts?.quantity ?? 1
  try {
    const { error } = await supabase.from("usage_events").insert({
      shop_id: shopId,
      kind,
      quantity,
      credits: creditsFor(kind, quantity),
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

export async function remainingCredits(
  supabase: SupabaseClient,
  shop: ShopCreditFields
): Promise<number> {
  const spent = await creditsSpentThisPeriod(supabase, shop)
  return Math.max(0, shop.credit_limit - spent)
}

/**
 * True when the shop has hit/exceeded its credit cap. The runtime fails closed
 * (stages nothing) and notifies. credit_limit is the cap; setting it to 0
 * pauses all metered automation.
 */
export async function isOverCreditLimit(
  supabase: SupabaseClient,
  shop: ShopCreditFields
): Promise<boolean> {
  const spent = await creditsSpentThisPeriod(supabase, shop)
  return spent >= shop.credit_limit
}
