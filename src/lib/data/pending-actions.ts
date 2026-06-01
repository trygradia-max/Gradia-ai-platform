import { createClient } from "@/lib/supabase/server"
import { getOptionalShop, requireShop } from "@/lib/shop"
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

/**
 * Cheap count of open approvals (pending + edit_requested) for the active
 * shop — powers the in-app Approvals badge. Returns 0 when there's no active
 * shop (e.g. mid-onboarding) so the layout never throws.
 */
export async function countOpenApprovalsForCurrentShop(): Promise<number> {
  const shop = await getOptionalShop()
  if (!shop) return 0
  const supabase = await createClient()

  const { count, error } = await supabase
    .from("pending_actions")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shop.id)
    .in("status", ["pending", "edit_requested"])

  if (error) {
    console.error("[pending-actions] count failed:", error)
    return 0
  }

  return count ?? 0
}
