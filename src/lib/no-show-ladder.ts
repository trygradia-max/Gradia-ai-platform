/**
 * No-show ladder decision logic (NEXT-2). Pure + deterministic so the windows
 * and state transitions are unit-tested without a DB or cron.
 *
 * The ladder around an upcoming appointment:
 *   1. confirm-by-text, staged ~CONFIRM_LEAD_HOURS out (HITL like every send),
 *   2. the existing 24h reminder (handled by the reminder cron — not here),
 *   3. if still unconfirmed within BACKFILL_CUTOFF_HOURS, surface a backfill
 *      nudge to the owner.
 *
 * A staged confirm is fired once (idempotent via confirm_pending_action_id).
 * Confirmation is set when the customer replies YES (inbound SMS handler).
 */

/** Stage the confirm-by-text once the appointment is within this many hours. */
export const CONFIRM_LEAD_HOURS = 48
/** Inside this window, an unconfirmed appointment is "at risk" → backfill nudge. */
export const BACKFILL_CUTOFF_HOURS = 12

export type LadderAppointment = {
  scheduled_at: string
  /** Set when the customer confirmed (replied YES). */
  confirmed_at: string | null
  /** Set once the confirm-by-text has been staged (idempotency stamp). */
  confirm_pending_action_id: string | null
}

export type NoShowState =
  | "confirmed" // customer said yes — ladder complete
  | "stage_confirm" // time to stage the confirm-by-text
  | "awaiting_confirm" // imminent + still unconfirmed → backfill nudge
  | "none" // nothing to do (too far out, already staged, or past)

/**
 * Where an appointment sits on the ladder right now. The cron acts on
 * "stage_confirm"; the owner-nudge surface acts on "awaiting_confirm".
 */
export function noShowLadderState(
  appt: LadderAppointment,
  nowMs: number
): NoShowState {
  const start = Date.parse(appt.scheduled_at)
  if (Number.isNaN(start)) return "none"
  const hoursUntil = (start - nowMs) / 3_600_000
  if (hoursUntil <= 0) return "none" // past or in progress — ladder doesn't apply

  if (appt.confirmed_at) return "confirmed"

  // Imminent + unconfirmed: at risk of a no-show → nudge the owner to backfill,
  // regardless of whether the confirm text went out.
  if (hoursUntil <= BACKFILL_CUTOFF_HOURS) return "awaiting_confirm"

  // Within the confirm lead time and not yet asked → stage the confirm text.
  if (!appt.confirm_pending_action_id && hoursUntil <= CONFIRM_LEAD_HOURS) {
    return "stage_confirm"
  }

  return "none"
}

function firstName(name: string | null | undefined): string {
  const n = (name ?? "").trim().split(/\s+/)[0]
  return n || "there"
}

/**
 * The confirm-by-text body — deterministic (not model-generated) so the "Reply
 * YES" instruction is always present and the appended details are exact. Signed
 * in the shop's name like every outbound.
 */
export function buildConfirmSms(input: {
  shopName: string
  customerName: string | null
  service: string | null
  whenText: string
}): string {
  const shop = input.shopName.trim() || "the shop"
  const svc = input.service?.trim() ? ` ${input.service.trim()}` : ""
  return (
    `Hi ${firstName(input.customerName)}, it's ${shop} — confirming your${svc} appointment ${input.whenText}. ` +
    `Reply YES to confirm, or call us to reschedule. — ${shop}`
  )
}

/**
 * True when an inbound reply reads as a confirmation. Kept tight to avoid false
 * positives; the inbound handler only applies it when the customer actually has
 * an imminent unconfirmed appointment, so the blast radius is bounded.
 */
export function looksLikeConfirm(content: string): boolean {
  return /\b(yes|yep|yup|yeah|confirm(ed|ing)?|sounds good|see you|i'?ll be there|we'?ll be there|ok|okay)\b/i.test(
    content
  )
}
