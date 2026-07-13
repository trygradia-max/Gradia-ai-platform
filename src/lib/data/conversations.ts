import { createClient } from "@/lib/supabase/server"
import { getOptionalShop } from "@/lib/shop"
import type { InteractionChannel, InteractionRole } from "@/lib/types/database"

/**
 * Conversation thread list (spec §4 / L3). A thread = one customer on
 * one channel, previewed by its latest stored turn — nothing generated,
 * nothing summarized (AI summaries are the L4 call-record work). The
 * "Needs you" badge is real: it means an open pending_action references
 * that customer.
 */

export type ConversationThread = {
  key: string
  customerId: string | null
  customerName: string | null
  channel: InteractionChannel
  /** Verbatim (truncated) latest turn — stored data, not a summary. */
  preview: string
  /** Who spoke last: the caller/texter or the receptionist. */
  lastRole: InteractionRole
  lastAt: string
  turnCount: number
  needsYou: boolean
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`
}

export async function listConversationThreads(
  limit = 20
): Promise<ConversationThread[]> {
  const shop = await getOptionalShop()
  if (!shop) return []
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("interactions")
    .select("customer_id, channel, role, content, occurred_at")
    .eq("shop_id", shop.id)
    .in("channel", ["voice", "sms"])
    .order("occurred_at", { ascending: false })
    .limit(400)

  if (error) {
    console.error("[data/conversations] threads query failed:", error)
    return []
  }

  type Turn = {
    customer_id: string | null
    channel: InteractionChannel
    role: InteractionRole
    content: string
    occurred_at: string
  }

  // Newest-first rows: the first row seen per (customer, channel) is the
  // thread's latest turn; the rest just increment its count.
  const threads = new Map<string, ConversationThread>()
  for (const t of (data as Turn[] | null) ?? []) {
    const key = `${t.customer_id ?? "unknown"}:${t.channel}`
    const existing = threads.get(key)
    if (existing) {
      existing.turnCount += 1
      continue
    }
    // Keep counting turns for threads we already hold, but don't open
    // new ones past the page size.
    if (threads.size >= limit) continue
    threads.set(key, {
      key,
      customerId: t.customer_id,
      customerName: null,
      channel: t.channel,
      preview: truncate(t.content, 120),
      lastRole: t.role,
      lastAt: t.occurred_at,
      turnCount: 1,
      needsYou: false,
    })
  }

  const list = [...threads.values()]
  const customerIds = [
    ...new Set(list.map((t) => t.customerId).filter((id): id is string => !!id)),
  ]
  if (customerIds.length > 0) {
    const [namesRes, pendingRes] = await Promise.all([
      supabase
        .from("customers")
        .select("id, name")
        .eq("shop_id", shop.id)
        .in("id", customerIds),
      supabase
        .from("pending_actions")
        .select("payload")
        .eq("shop_id", shop.id)
        .in("status", ["pending", "edit_requested"]),
    ])
    const names = new Map(
      (((namesRes.data as { id: string; name: string | null }[] | null) ?? []).map(
        (c) => [c.id, c.name] as const
      ))
    )
    const pendingCustomerIds = new Set(
      (((pendingRes.data as { payload: Record<string, unknown> }[] | null) ?? [])
        .map((p) => p.payload?.customer_id)
        .filter((id): id is string => typeof id === "string"))
    )
    for (const t of list) {
      if (t.customerId) {
        t.customerName = names.get(t.customerId) ?? null
        t.needsYou = pendingCustomerIds.has(t.customerId)
      }
    }
  }

  return list
}
