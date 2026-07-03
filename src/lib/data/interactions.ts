import { createClient } from "@/lib/supabase/server"
import { getOptionalShop } from "@/lib/shop"

/**
 * Whether this shop has any conversational history (voice/SMS turns in
 * the shared memory layer). Used by /conversations to pick the honest
 * empty state: first-use teaching copy vs "threads land here next"
 * (the thread list itself ships with the L4 call-record work).
 */
export async function hasConversationHistory(): Promise<boolean> {
  const shop = await getOptionalShop()
  if (!shop) return false
  const supabase = await createClient()
  const { count, error } = await supabase
    .from("interactions")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shop.id)
    .in("channel", ["voice", "sms"])
  if (error) {
    console.error("[data/interactions] history count failed:", error)
    return false
  }
  return (count ?? 0) > 0
}
