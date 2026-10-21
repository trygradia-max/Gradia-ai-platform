import type { MessageDeliveryReview } from "@/lib/message-delivery-review"
import type { PendingActionRow } from "@/lib/types/database"

/** Internal read model, not authorization or an executor. Callers must authorize
 * source reads. No customer payloads, credentials, or generated claims are copied.
 * Source rows stay authoritative; this projection never changes their lifecycle.
 */
export type OperationsAction = Pick<PendingActionRow,
  "id" | "shop_id" | "action_type" | "status" | "result_id" | "created_at"
> & { delivery: MessageDeliveryReview; deliveryConflict: boolean }
export type OperationsQueueItem = {
  sourceId: string
  actionType: PendingActionRow["action_type"]
  state: "needs_review" | "outcome_unconfirmed"
  createdAt: string
}
export type OperationsQueue =
  | { status: "unavailable"; items: []; reason: "source_unavailable" | "scope_mismatch" }
  | { status: "ready"; items: OperationsQueueItem[]; hasMore: boolean;
      countsInLoadedWindow: { needsReview: number; outcomeUnconfirmed: number } }

/** A bounded window, never a total or a daily success metric. Unknown message
 * evidence takes precedence over pending/rejected status: no retry is implied.
 * Provider acceptance is not customer delivery and is never labelled as such.
 */
export function projectOperationsQueue(shopId: string, source:
  | { status: "unavailable" }
  | { status: "ready"; actions: OperationsAction[]; hasMore: boolean }
): OperationsQueue {
  if (source.status === "unavailable") {
    return { status: "unavailable", items: [], reason: "source_unavailable" }
  }
  if (!shopId || source.actions.some(action => action.shop_id !== shopId)) {
    return { status: "unavailable", items: [], reason: "scope_mismatch" }
  }
  const items: OperationsQueueItem[] = []
  for (const action of source.actions) {
    const message = action.action_type === "send_sms" || action.action_type === "send_email"
    const uncertain = message && (
      action.deliveryConflict || action.delivery.state === "unavailable" ||
      action.delivery.state === "claimed" ||
      (action.delivery.state === "provider_accepted" &&
        (!action.delivery.completedAt || !action.result_id || action.status !== "approved"))
    )
    let state: OperationsQueueItem["state"] | null = null
    if (uncertain) state = "outcome_unconfirmed"
    else if (action.status === "pending" || action.status === "edit_requested") state = "needs_review"
    else if (action.status !== "rejected" && !(action.status === "approved" && action.result_id)) {
      state = "outcome_unconfirmed"
    }
    if (state) items.push({ sourceId: action.id, actionType: action.action_type, state, createdAt: action.created_at })
  }
  return {
    status: "ready", items, hasMore: source.hasMore,
    countsInLoadedWindow: {
      needsReview: items.filter(item => item.state === "needs_review").length,
      outcomeUnconfirmed: items.filter(item => item.state === "outcome_unconfirmed").length,
    },
  }
}
