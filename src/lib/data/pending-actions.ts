import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"
import type { PendingActionRow } from "@/lib/types/database"

export async function listOpenApprovalsForCurrentShop(): Promise<
  PendingActionRow[]
> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("pending_actions")
    .select("*")
    .eq("shop_id", shop.id)
    .in("status", ["pending", "edit_requested"])
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  return data ?? []
}
