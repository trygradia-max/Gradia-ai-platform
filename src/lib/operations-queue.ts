import type { MessageDeliveryReview } from "@/lib/message-delivery-review"
import type { PendingActionRow } from "@/lib/types/database"

/** Internal read model, not authorization or an executor. Callers must authorize
 * source reads. No customer payloads, credentials, or generated claims are copied.
 * Source rows stay authoritative; this projection never changes their lifecycle.
 */
export type OperationsAction = Pick<
  PendingActionRow,
  "id" | "shop_id" | "action_type" | "status" | "result_id" | "created_at"
> & {
  delivery: MessageDeliveryReview
  deliveryConflict: boolean
  linkedWorkflowId: string | null
}
export type OperationsIntake = {
  id: string
  shop_id: string
  revision: number
  last_received_at: string
}
export type OperationsSource =
  | {
      kind: "pending_action"
      id: string
      actionType: PendingActionRow["action_type"]
      href: string
    }
  | { kind: "intake_workflow"; id: string; revision: number; href: string }
export type OperationsQueueItem = {
  /** Stable grouping key. A qualification action and its workflow are one work item. */
  workKey: string
  state: "needs_review" | "outcome_unconfirmed"
  observedAt: string
  sources: OperationsSource[]
}
export type OperationsQueue =
  | {
      status: "unavailable"
      items: []
      reason: "source_unavailable" | "scope_mismatch"
    }
  | {
      status: "ready"
      items: OperationsQueueItem[]
      hasMore: boolean
      countsInLoadedWindow: {
        needsReview: number
        outcomeUnconfirmed: number
      }
    }

export type OperationsDailyBrief =
  | {
      status: "unavailable"
      observedAt: string
      reason: "source_unavailable" | "scope_mismatch"
      sections: []
    }
  | {
      status: "ready"
      observedAt: string
      coverage: "complete" | "partial"
      countsInLoadedWindow: {
        needsReview: number
        outcomeUnconfirmed: number
      }
      sections: Array<{
        kind: "needs_review" | "outcome_unconfirmed"
        countInLoadedWindow: number
        items: OperationsQueueItem[]
      }>
    }

type ReadySources = {
  status: "ready"
  actions: OperationsAction[]
  intakes: OperationsIntake[]
  hasMore: boolean
}

function actionState(action: OperationsAction): OperationsQueueItem["state"] | null {
  const message = action.action_type === "send_sms" || action.action_type === "send_email"
  const uncertain =
    message &&
    (action.deliveryConflict ||
      action.delivery.state === "unavailable" ||
      action.delivery.state === "claimed" ||
      (action.delivery.state === "provider_accepted" &&
        (!action.delivery.completedAt || !action.result_id || action.status !== "approved")))
  if (uncertain) return "outcome_unconfirmed"
  if (action.status === "pending" || action.status === "edit_requested") return "needs_review"
  if (action.status !== "rejected" && !(action.status === "approved" && action.result_id)) {
    return "outcome_unconfirmed"
  }
  return null
}

function actionHref(
  shopId: string,
  action: OperationsAction,
  state: OperationsQueueItem["state"],
  viewerRole: "owner" | "manager"
): string {
  if (viewerRole === "owner") return `/approvals/${action.id}`
  const route = state === "needs_review" ? "/team/approvals" : "/team/delivery-reviews"
  return `${route}?shop=${encodeURIComponent(shopId)}`
}

function addItem(grouped: Map<string, OperationsQueueItem>, item: OperationsQueueItem): void {
  const current = grouped.get(item.workKey)
  if (!current) {
    grouped.set(item.workKey, item)
    return
  }
  current.sources.push(...item.sources)
  if (item.state === "outcome_unconfirmed") current.state = "outcome_unconfirmed"
  if (item.observedAt > current.observedAt) current.observedAt = item.observedAt
}

/** A bounded window, never a total or a daily success metric. Unknown message
 * evidence takes precedence over pending/rejected status: no retry is implied.
 * Provider acceptance is not customer delivery and is never labelled as such.
 */
export function projectOperationsQueue(
  shopId: string,
  source: { status: "unavailable" } | ReadySources,
  viewerRole: "owner" | "manager" = "owner"
): OperationsQueue {
  if (source.status === "unavailable") {
    return { status: "unavailable", items: [], reason: "source_unavailable" }
  }
  if (
    !shopId ||
    [...source.actions, ...source.intakes].some((record) => record.shop_id !== shopId)
  ) {
    return { status: "unavailable", items: [], reason: "scope_mismatch" }
  }

  const grouped = new Map<string, OperationsQueueItem>()
  for (const action of source.actions) {
    const state = actionState(action)
    if (!state) continue
    const workKey = action.linkedWorkflowId
      ? `lead_workflow:${action.linkedWorkflowId}`
      : `pending_action:${action.id}`
    addItem(grouped, {
      workKey,
      state,
      observedAt: action.created_at,
      sources: [
        {
          kind: "pending_action",
          id: action.id,
          actionType: action.action_type,
          href: actionHref(shopId, action, state, viewerRole),
        },
      ],
    })
  }
  for (const intake of source.intakes) {
    addItem(grouped, {
      workKey: `lead_workflow:${intake.id}`,
      state: "needs_review",
      observedAt: intake.last_received_at,
      sources: [
        {
          kind: "intake_workflow",
          id: intake.id,
          revision: intake.revision,
          href: `/intake?shop=${encodeURIComponent(shopId)}`,
        },
      ],
    })
  }

  const items = [...grouped.values()].sort(
    (left, right) =>
      right.observedAt.localeCompare(left.observedAt) || right.workKey.localeCompare(left.workKey)
  )
  return {
    status: "ready",
    items,
    hasMore: source.hasMore,
    countsInLoadedWindow: {
      needsReview: items.filter((item) => item.state === "needs_review").length,
      outcomeUnconfirmed: items.filter((item) => item.state === "outcome_unconfirmed").length,
    },
  }
}

/** Deterministic, factual brief over exactly one authorized queue page. A partial
 * page stays partial; this contract never promotes window counts into global totals.
 */
export function projectOperationsDailyBrief(
  queue: OperationsQueue,
  observedAt: string
): OperationsDailyBrief {
  if (queue.status === "unavailable") {
    return { status: "unavailable", observedAt, reason: queue.reason, sections: [] }
  }
  const kinds = ["needs_review", "outcome_unconfirmed"] as const
  return {
    status: "ready",
    observedAt,
    coverage: queue.hasMore ? "partial" : "complete",
    countsInLoadedWindow: queue.countsInLoadedWindow,
    sections: kinds.map((kind) => {
      const items = queue.items.filter((item) => item.state === kind)
      return { kind, countInLoadedWindow: items.length, items }
    }),
  }
}
