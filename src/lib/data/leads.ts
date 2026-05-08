import { createClient } from "@/lib/supabase/server"
import type { LeadRow } from "@/lib/types/database"
import { requireShop } from "@/lib/shop"

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
