/**
 * Delivery progress, earliest first (review finding I5). Twilio's lifecycle
 * is accepted/scheduled → queued → sending → sent → one terminal outcome:
 * delivered, or undelivered / failed / canceled. Some channels add `read`
 * after delivered. Twilio doesn't guarantee callback order, so the stored
 * status only ever moves forward:
 *
 *   - A status with a lower or equal rank never replaces a stored one, so a
 *     late `sent` can't overwrite `delivered`, and a replay is a no-op.
 *   - The FIRST terminal outcome stored is the one shown. A different
 *     terminal outcome arriving later (delivered after undelivered/failed,
 *     or undelivered/failed after delivered, in either order) doesn't
 *     replace it: callbacks carry no event time, so arrival order can't say
 *     which outcome is true. It is kept beside it as a conflict
 *     (`conflictingTerminalOutcome`) so the disagreement is visible for
 *     review instead of silently dropped.
 *   - `read` only follows a delivered message.
 *   - An unknown status never replaces a known one.
 */
const DELIVERY_STATUS_RANK: Record<string, number> = {
  accepted: 0,
  scheduled: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
  canceled: 4,
  read: 5,
}

const FAILED_OUTCOMES = new Set(["undelivered", "failed", "canceled"])

export function deliveryStatusRank(status: string | null): number | null {
  if (!status) return null
  return DELIVERY_STATUS_RANK[status.toLowerCase()] ?? null
}

/** True when `next` moves the stored status strictly forward. */
export function advancesDeliveryStatus(current: string | null, next: string): boolean {
  const from = deliveryStatusRank(current)
  const to = deliveryStatusRank(next)
  if (to === null) return current === null
  if (next.toLowerCase() === "read" && current && FAILED_OUTCOMES.has(current.toLowerCase())) return false
  return from === null || to > from
}

/**
 * True when both statuses are terminal outcomes that disagree: one says the
 * message arrived (delivered/read), the other that it didn't.
 */
export function conflictingTerminalOutcome(current: string | null, next: string): boolean {
  const from = deliveryStatusRank(current)
  const to = deliveryStatusRank(next)
  if (from === null || to === null || from < 4 || to < 4) return false
  return FAILED_OUTCOMES.has(current!.toLowerCase()) !== FAILED_OUTCOMES.has(next.toLowerCase())
}

export type SmsDeliveryState =
  | { state: "conflicting"; recorded: string; conflict: string; errorCode: string | null; conflictErrorCode: string | null }
  | { state: "delivered" | "failed" | "sent" | "queued" | "unknown"; errorCode: string | null }

/**
 * What an outbound SMS's delivery metadata may truthfully say. A message
 * with a recorded conflicting terminal outcome (metadata.twilio_status_conflict)
 * is "conflicting", never "delivered" or "failed" on its own: show both
 * outcomes, and point to the delivery review (list_delivery_conflicts).
 */
export function smsDeliveryState(metadata: Record<string, unknown> | null | undefined): SmsDeliveryState {
  const meta = metadata ?? {}
  const status = typeof meta.twilio_status === "string" ? meta.twilio_status.toLowerCase() : ""
  const errorCode = meta.twilio_error_code != null ? String(meta.twilio_error_code) : null
  const conflict = meta.twilio_status_conflict as { status?: unknown; error_code?: unknown } | undefined
  if (conflict && typeof conflict === "object" && typeof conflict.status === "string") {
    return {
      state: "conflicting",
      recorded: status || "unknown",
      conflict: conflict.status.toLowerCase(),
      errorCode,
      conflictErrorCode: conflict.error_code != null ? String(conflict.error_code) : null,
    }
  }
  if (status === "delivered" || status === "read") return { state: "delivered", errorCode }
  if (FAILED_OUTCOMES.has(status)) return { state: "failed", errorCode }
  if (status === "sent" || status === "sending") return { state: "sent", errorCode }
  if (status === "queued" || status === "accepted" || status === "scheduled") return { state: "queued", errorCode }
  return { state: "unknown", errorCode }
}
