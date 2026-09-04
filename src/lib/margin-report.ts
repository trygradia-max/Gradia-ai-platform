/**
 * Per-shop gross-margin report from usage_events (GRADIA_PRICING.md
 * margin rule #3 — the verification that the ~70% usage margin holds in
 * practice, not just in config).
 *
 * Every metered row carries wholesale_cost + retail_cost, so margin is
 * computable per shop, per kind, per period — straight off the ledger,
 * no pricing math re-derived here. Rows from before the margin columns
 * (legacy kinds) count toward credits-spent but are excluded from margin
 * (flagged in the report so nobody mistakes missing data for free COGS).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { tierSpec } from "@/lib/pricing"
import type { UsageEventKind } from "@/lib/types/database"

export type MarginRow = {
  shop_id: string
  kind: UsageEventKind
  quantity: number
  wholesale_cost: number | null
  retail_cost: number | null
}

export type KindBreakdown = {
  kind: UsageEventKind
  events: number
  quantity: number
  wholesaleCents: number
  retailCents: number
  marginCents: number
  marginPct: number | null
}

/** Flag shops whose vendor COGS is eating this fraction of what they pay
 *  us per month. The SKU design point is COGS ≈ 28% of plan price
 *  (GRADIA_PRICING.md margin rules) — 50% means the plan economics are
 *  drifting and the shop needs a look (heavy usage, mispriced kind, or a
 *  metering gap). */
export const NEAR_PLAN_REVENUE_FRACTION = 0.5

export type ShopMargin = {
  shopId: string
  shopName: string
  wholesaleCents: number
  retailCents: number
  marginCents: number
  /** null when the shop has no priced usage (margin of nothing isn't 100%). */
  marginPct: number | null
  /** What the shop pays monthly — the tier price while active (P0-013). 0 = free/past_due. */
  planRevenueCents: number
  /** wholesale COGS / plan revenue — the number the flag watches. */
  cogsOfPlanPct: number | null
  /** True when COGS ≥ 50% of plan revenue — review this shop. */
  nearPlanRevenue: boolean
  /** Rows without cost columns (legacy) — excluded from the totals above. */
  unpricedEvents: number
  byKind: KindBreakdown[]
}

export type MarginReport = {
  periodStart: string
  shops: ShopMargin[]
  totals: {
    wholesaleCents: number
    retailCents: number
    marginCents: number
    marginPct: number | null
  }
}

function pct(retail: number, wholesale: number): number | null {
  if (retail <= 0) return null
  return ((retail - wholesale) / retail) * 100
}

export type ShopMeta = {
  name: string
  /** Monthly plan revenue in cents — tierSpec(tier).priceCents while active; 0 = free. */
  planRevenueCents: number
}

/** Pure aggregation — testable without a database. */
export function computeMarginReport(
  rows: MarginRow[],
  shopMeta: Map<string, ShopMeta>,
  periodStart: string
): MarginReport {
  const byShop = new Map<
    string,
    { unpriced: number; kinds: Map<string, KindBreakdown> }
  >()

  for (const row of rows) {
    let shop = byShop.get(row.shop_id)
    if (!shop) {
      shop = { unpriced: 0, kinds: new Map() }
      byShop.set(row.shop_id, shop)
    }
    if (row.wholesale_cost == null || row.retail_cost == null) {
      shop.unpriced += 1
      continue
    }
    let kind = shop.kinds.get(row.kind)
    if (!kind) {
      kind = {
        kind: row.kind,
        events: 0,
        quantity: 0,
        wholesaleCents: 0,
        retailCents: 0,
        marginCents: 0,
        marginPct: null,
      }
      shop.kinds.set(row.kind, kind)
    }
    kind.events += 1
    kind.quantity += row.quantity
    kind.wholesaleCents += row.wholesale_cost
    kind.retailCents += row.retail_cost
  }

  const shops: ShopMargin[] = []
  let totalWholesale = 0
  let totalRetail = 0

  for (const [shopId, data] of byShop) {
    const byKind = [...data.kinds.values()]
      .map((k) => ({
        ...k,
        marginCents: k.retailCents - k.wholesaleCents,
        marginPct: pct(k.retailCents, k.wholesaleCents),
      }))
      .sort((a, b) => b.retailCents - a.retailCents)
    const wholesaleCents = byKind.reduce((s, k) => s + k.wholesaleCents, 0)
    const retailCents = byKind.reduce((s, k) => s + k.retailCents, 0)
    totalWholesale += wholesaleCents
    totalRetail += retailCents
    const meta = shopMeta.get(shopId)
    const planRevenueCents = meta?.planRevenueCents ?? 0
    const cogsOfPlanPct =
      planRevenueCents > 0 ? (wholesaleCents / planRevenueCents) * 100 : null
    shops.push({
      shopId,
      shopName: meta?.name ?? shopId,
      wholesaleCents,
      retailCents,
      marginCents: retailCents - wholesaleCents,
      marginPct: pct(retailCents, wholesaleCents),
      planRevenueCents,
      cogsOfPlanPct,
      nearPlanRevenue:
        planRevenueCents > 0 &&
        wholesaleCents >= planRevenueCents * NEAR_PLAN_REVENUE_FRACTION,
      unpricedEvents: data.unpriced,
      byKind,
    })
  }

  shops.sort((a, b) => b.retailCents - a.retailCents)
  return {
    periodStart,
    shops,
    totals: {
      wholesaleCents: totalWholesale,
      retailCents: totalRetail,
      marginCents: totalRetail - totalWholesale,
      marginPct: pct(totalRetail, totalWholesale),
    },
  }
}

/** Month-to-date (UTC calendar month) by default. */
export async function buildMarginReport(
  supabase: SupabaseClient,
  opts?: { since?: string }
): Promise<MarginReport> {
  const now = new Date()
  const since =
    opts?.since ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  const [{ data: rows, error }, { data: shopRows }] = await Promise.all([
    supabase
      .from("usage_events")
      .select("shop_id, kind, quantity, wholesale_cost, retail_cost")
      .gte("created_at", since),
    supabase.from("shops").select("id, name, plan, tier"),
  ])
  if (error) throw new Error(`usage query failed: ${error.message}`)

  const meta = new Map<string, ShopMeta>(
    (
      (shopRows as
        | { id: string; name: string; plan: string; tier: string }[]
        | null) ?? []
    ).map((s) => [
      s.id,
      {
        name: s.name,
        planRevenueCents: s.plan === "active" ? tierSpec(s.tier).priceCents : 0,
      },
    ])
  )
  return computeMarginReport((rows as MarginRow[] | null) ?? [], meta, since)
}
