import { createClient } from "@/lib/supabase/server"
import {
  buildHeatContext,
  computeHeatScore,
  type HeatScore,
} from "@/lib/scoring"
import { requireShop } from "@/lib/shop"
import type { LeadRow } from "@/lib/types/database"

export type ScoredLead = LeadRow & { heat: HeatScore }

export async function listLeadsForCurrentShop(): Promise<LeadRow[]> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}

/**
 * Same as listLeadsForCurrentShop but annotated with a HeatScore per
 * lead. One bulk context load up front; per-lead scoring is O(1).
 */
export async function listScoredLeadsForCurrentShop(): Promise<ScoredLead[]> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })

  if (error) throw new Error(error.message)
  const leads = (data as LeadRow[] | null) ?? []
  if (leads.length === 0) return []

  const context = await buildHeatContext(supabase, shop.id, leads)
  return leads.map((lead) => ({
    ...lead,
    heat: computeHeatScore(lead, context),
  }))
}
