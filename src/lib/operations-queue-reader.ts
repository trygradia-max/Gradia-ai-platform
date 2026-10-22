import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  projectOperationsQueue,
  type OperationsAction,
  type OperationsQueue,
} from "@/lib/operations-queue"

const pendingActionType = z.enum([
  "update_customer",
  "resolve_customer",
  "record_interaction",
  "create_lead",
  "add_note",
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "send_sms",
  "send_email",
  "create_quote",
])
const queueRow = z.object({
  id: z.string().uuid(),
  shop_id: z.string().uuid(),
  action_type: pendingActionType,
  status: z.enum(["pending", "approved", "edit_requested", "rejected"]),
  result_id: z.string().uuid().nullable(),
  created_at: z.string().datetime({ offset: true }),
  delivery_state: z.enum(["unspent", "claimed", "provider_accepted"]),
  claimed_at: z.string().datetime({ offset: true }).nullable(),
  completed_at: z.string().datetime({ offset: true }).nullable(),
  delivery_conflict: z.boolean(),
}).strict().superRefine((row, context) => {
  const valid = row.delivery_state === "unspent"
    ? row.claimed_at === null && row.completed_at === null
    : row.delivery_state === "claimed"
      ? row.claimed_at !== null && row.completed_at === null
      : row.claimed_at !== null && row.completed_at !== null
  if (!valid) context.addIssue({ code: "custom", message: "Inconsistent delivery evidence" })
})
const queueRead = z.object({
  viewer_role: z.enum(["owner", "manager"]),
  items: z.array(queueRow).max(51),
}).strict()

export type OperationsQueueCursor = { createdAt: string; sourceId: string }
export type OperationsQueuePage = OperationsQueue & {
  viewerRole?: "owner" | "manager"
  nextCursor?: OperationsQueueCursor | null
}

type RpcClient = Pick<SupabaseClient, "rpc">

/**
 * Reads one authorized page from the database projection. The RPC independently
 * checks the signed-in caller's live membership and manager grants. A refused,
 * failed, or malformed read is unavailable, never an empty queue.
 */
export async function readOperationsQueuePage(
  db: RpcClient,
  shopId: string,
  options: { limit?: number; cursor?: OperationsQueueCursor | null } = {}
): Promise<OperationsQueuePage> {
  const limit = options.limit ?? 20
  if (!z.string().uuid().safeParse(shopId).success ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return { status: "unavailable", items: [], reason: "source_unavailable" }
  }
  const cursor = options.cursor ?? null
  if (cursor && (!z.string().datetime({ offset: true }).safeParse(cursor.createdAt).success ||
      !z.string().uuid().safeParse(cursor.sourceId).success)) {
    return { status: "unavailable", items: [], reason: "source_unavailable" }
  }
  try {
    const { data, error } = await db.rpc("list_operations_queue", {
      p_shop: shopId,
      p_before_created_at: cursor?.createdAt ?? null,
      p_before_id: cursor?.sourceId ?? null,
      p_limit: limit,
    })
    if (error) return { status: "unavailable", items: [], reason: "source_unavailable" }
    const parsed = queueRead.safeParse(data)
    if (!parsed.success) return { status: "unavailable", items: [], reason: "source_unavailable" }

    const hasMore = parsed.data.items.length > limit
    const rows = parsed.data.items.slice(0, limit)
    const actions: OperationsAction[] = rows.map((row) => ({
      id: row.id,
      shop_id: row.shop_id,
      action_type: row.action_type,
      status: row.status,
      result_id: row.result_id,
      created_at: row.created_at,
      delivery: row.delivery_state === "unspent"
        ? { state: "unspent" }
        : {
            state: row.delivery_state,
            claimedAt: row.claimed_at!,
            completedAt: row.completed_at,
          },
      deliveryConflict: row.delivery_conflict,
    }))
    const projected = projectOperationsQueue(shopId, { status: "ready", actions, hasMore })
    if (projected.status === "unavailable") return projected
    const last = rows.at(-1)
    return {
      ...projected,
      viewerRole: parsed.data.viewer_role,
      nextCursor: hasMore && last
        ? { createdAt: last.created_at, sourceId: last.id }
        : null,
    }
  } catch {
    return { status: "unavailable", items: [], reason: "source_unavailable" }
  }
}
