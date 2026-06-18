import { createClient } from "@/lib/supabase/server"
import { getOptionalShop, requireShop } from "@/lib/shop"
import type { PendingActionRow, PendingActionType } from "@/lib/types/database"

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

export type AgentActivityItem = {
  id: string
  actionType: PendingActionType
  summary: string
  customerId: string | null
  at: string
}

function truncate(s: string, n: number): string {
  const t = s.trim()
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`
}

function activitySummary(
  actionType: PendingActionType,
  payload: Record<string, unknown>
): string {
  const name = (payload.customer_name as string)?.trim() || "a customer"
  switch (actionType) {
    case "send_sms":
      return `Texted ${name}`
    case "send_email": {
      const subject = (payload.subject as string)?.trim()
      return subject ? `Emailed ${name} — “${truncate(subject, 40)}”` : `Emailed ${name}`
    }
    case "create_lead":
      return `Logged a lead — ${name}`
    case "add_note":
      return "Saved a note to memory"
    case "book_appointment":
      return `Booked ${name}`
    default:
      return `Handled ${name}`
  }
}

/**
 * Recent actions our agents actually completed (executed pending_actions from
 * custom agents) — the autonomous-mode "done event" feed (BUILD_REFERENCE §5).
 * Read-only.
 */
export async function listRecentAgentActivity(
  limit = 8
): Promise<AgentActivityItem[]> {
  const shop = await getOptionalShop()
  if (!shop) return []
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("pending_actions")
    .select("id, action_type, payload, decided_at, created_at")
    .eq("shop_id", shop.id)
    .eq("status", "approved")
    .in("payload->>source", ["custom_agent", "custom_agent_event"])
    .order("decided_at", { ascending: false })
    .limit(limit)
  if (error) {
    console.error("[pending-actions] activity query failed:", error)
    return []
  }
  type Row = {
    id: string
    action_type: PendingActionType
    payload: Record<string, unknown> | null
    decided_at: string | null
    created_at: string
  }
  return ((data as Row[] | null) ?? []).map((r) => ({
    id: r.id,
    actionType: r.action_type,
    summary: activitySummary(r.action_type, r.payload ?? {}),
    customerId: (r.payload?.customer_id as string) ?? null,
    at: r.decided_at ?? r.created_at,
  }))
}
