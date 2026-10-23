import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  projectOperationsDailyBrief,
  projectOperationsQueue,
  type OperationsAction,
  type OperationsDailyBrief,
  type OperationsIntake,
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
const queueRow = z
  .object({
    source_kind: z.enum(["pending_action", "intake_workflow"]),
    source_id: z.string().uuid(),
    shop_id: z.string().uuid(),
    observed_at: z.string().datetime({ offset: true }),
    action_type: pendingActionType.nullable(),
    action_status: z.enum(["pending", "approved", "edit_requested", "rejected"]).nullable(),
    result_id: z.string().uuid().nullable(),
    delivery_state: z.enum(["unspent", "claimed", "provider_accepted"]).nullable(),
    claimed_at: z.string().datetime({ offset: true }).nullable(),
    completed_at: z.string().datetime({ offset: true }).nullable(),
    delivery_conflict: z.boolean().nullable(),
    linked_workflow_id: z.string().uuid().nullable(),
    intake_revision: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.source_kind === "intake_workflow") {
      const valid =
        row.action_type === null &&
        row.action_status === null &&
        row.result_id === null &&
        row.delivery_state === null &&
        row.claimed_at === null &&
        row.completed_at === null &&
        row.delivery_conflict === null &&
        row.linked_workflow_id === row.source_id &&
        row.intake_revision !== null
      if (!valid) context.addIssue({ code: "custom", message: "Inconsistent intake evidence" })
      return
    }
    const evidenceValid =
      row.delivery_state === "unspent"
        ? row.claimed_at === null && row.completed_at === null
        : row.delivery_state === "claimed"
          ? row.claimed_at !== null && row.completed_at === null
          : row.delivery_state === "provider_accepted" &&
            row.claimed_at !== null &&
            row.completed_at !== null
    const valid =
      row.action_type !== null &&
      row.action_status !== null &&
      row.delivery_state !== null &&
      row.delivery_conflict !== null &&
      row.intake_revision === null &&
      evidenceValid
    if (!valid) context.addIssue({ code: "custom", message: "Inconsistent action evidence" })
  })
const queueRead = z
  .object({
    viewer_role: z.enum(["owner", "manager"]),
    items: z.array(queueRow).max(51),
  })
  .strict()

export type OperationsQueueCursor = {
  observedAt: string
  sourceKind: "pending_action" | "intake_workflow"
  sourceId: string
}
export type OperationsQueuePage = OperationsQueue & {
  observedAt: string
  viewerRole?: "owner" | "manager"
  nextCursor: OperationsQueueCursor | null
}
export type OperationsOverview = { queue: OperationsQueuePage; brief: OperationsDailyBrief }

type RpcClient = Pick<SupabaseClient, "rpc">

export function unavailableOperationsQueuePage(
  observedAt = new Date().toISOString()
): OperationsQueuePage {
  return {
    status: "unavailable",
    items: [],
    reason: "source_unavailable",
    observedAt,
    nextCursor: null,
  }
}

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
  const observedAt = new Date().toISOString()
  const unavailable = () => unavailableOperationsQueuePage(observedAt)
  const limit = options.limit ?? 20
  if (
    !z.string().uuid().safeParse(shopId).success ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    return unavailable()
  }
  const cursor = options.cursor ?? null
  if (
    cursor &&
    (!z.string().datetime({ offset: true }).safeParse(cursor.observedAt).success ||
      !z.enum(["pending_action", "intake_workflow"]).safeParse(cursor.sourceKind).success ||
      !z.string().uuid().safeParse(cursor.sourceId).success)
  ) {
    return unavailable()
  }
  try {
    const { data, error } = await db.rpc("list_operations_queue", {
      p_shop: shopId,
      p_before_observed_at: cursor?.observedAt ?? null,
      p_before_source_kind: cursor?.sourceKind ?? null,
      p_before_source_id: cursor?.sourceId ?? null,
      p_limit: limit,
    })
    if (error) return unavailable()
    const parsed = queueRead.safeParse(data)
    if (!parsed.success) return unavailable()

    const hasMore = parsed.data.items.length > limit
    const rows = parsed.data.items.slice(0, limit)
    const actions: OperationsAction[] = []
    const intakes: OperationsIntake[] = []
    for (const row of rows) {
      if (row.source_kind === "intake_workflow") {
        intakes.push({
          id: row.source_id,
          shop_id: row.shop_id,
          revision: row.intake_revision!,
          last_received_at: row.observed_at,
        })
        continue
      }
      actions.push({
        id: row.source_id,
        shop_id: row.shop_id,
        action_type: row.action_type!,
        status: row.action_status!,
        result_id: row.result_id,
        created_at: row.observed_at,
        delivery:
          row.delivery_state === "unspent"
            ? { state: "unspent" }
            : {
                state: row.delivery_state!,
                claimedAt: row.claimed_at!,
                completedAt: row.completed_at,
              },
        deliveryConflict: row.delivery_conflict!,
        linkedWorkflowId: row.linked_workflow_id,
      })
    }
    const projected = projectOperationsQueue(
      shopId,
      { status: "ready", actions, intakes, hasMore },
      parsed.data.viewer_role
    )
    if (projected.status === "unavailable") {
      return { ...projected, observedAt, nextCursor: null }
    }
    const last = rows.at(-1)
    return {
      ...projected,
      observedAt,
      viewerRole: parsed.data.viewer_role,
      nextCursor:
        hasMore && last
          ? {
              observedAt: last.observed_at,
              sourceKind: last.source_kind,
              sourceId: last.source_id,
            }
          : null,
    }
  } catch {
    return unavailable()
  }
}

export function operationsOverviewFromPage(page: OperationsQueuePage): OperationsOverview {
  return { queue: page, brief: projectOperationsDailyBrief(page, page.observedAt) }
}
