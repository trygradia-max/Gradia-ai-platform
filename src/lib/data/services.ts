import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"
import type { ServiceRow } from "@/lib/types/database"

export async function listServicesForCurrentShop(): Promise<ServiceRow[]> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}
