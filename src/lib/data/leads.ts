import { createClient } from "@/lib/supabase/server"
import {
  buildHeatContext,
  computeHeatScore,
  type HeatScore,
} from "@/lib/scoring"
import { requireShop } from "@/lib/shop"
import type { LeadRow } from "@/lib/types/database"

export type ScoredLead = LeadRow & { heat: HeatScore }

/** Newest-first cap for dashboard lead surfaces — matches the pipeline
 *  board's 500 cap. Both readers here previously fetched the entire
 *  table on every Home render (2026-07-13 master audit P1). */
const LEAD_LIST_LIMIT = 500

export async function listLeadsForCurrentShop(): Promise<LeadRow[]> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
    .limit(LEAD_LIST_LIMIT)

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}

/**
 * Same as listLeadsForCurrentShop but annotated with a HeatScore per
 * lead. One bulk context load up front; per-lead scoring is O(1).
 *
 * `limit` caps the rows (and therefore the heat-context fan-out, which
 * queries interactions + payments for every lead's customer). PERF-001:
 * Home's live feed rendered all 500 rows on every visit — 2 MB of HTML for
 * a module that shows the newest handful — so Home passes a small cap.
 */
export async function listScoredLeadsForCurrentShop(
  limit: number = LEAD_LIST_LIMIT
): Promise<ScoredLead[]> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, LEAD_LIST_LIMIT)))

  if (error) throw new Error(error.message)
  const leads = (data as LeadRow[] | null) ?? []
  if (leads.length === 0) return []

  const context = await buildHeatContext(supabase, shop.id, leads)
  return leads.map((lead) => ({
    ...lead,
    heat: computeHeatScore(lead, context),
  }))
}

/** Cheap exact count — lets a capped feed say "See all N" truthfully. */
export async function countLeadsForCurrentShop(): Promise<number> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { count, error } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shop.id)
  if (error) {
    console.error("[data/leads] count failed:", error)
    return 0
  }
  return count ?? 0
}
