/**
 * TCPA / CAN-SPAM win-back channel gate (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §3.2). This is a GUARDRAIL IN CODE, not a
 * prompt — the audience resolver calls it to decide how (or whether) a
 * recovered customer may be contacted. It must never be loosened by a mode,
 * flag, or prompt; the locking test is the contract.
 *
 * The rule (conservative by construction):
 *   - do_not_contact → contact NOBODY (the owner's manual hard block).
 *   - SMS only when ALL hold: a phone exists, the customer is NOT SMS-opted-out,
 *     and the last transaction is within the 18-month established-business-
 *     relationship (EBR) window.
 *   - Everyone else → EMAIL when an address exists (CAN-SPAM: identity +
 *     working unsubscribe live in the drafter template).
 *   - No reachable channel → none.
 *
 * One win-back message per customer; no drip until they reply (enforced by the
 * recipe machinery + cooldowns, not here).
 */

/** TCPA established-business-relationship window for marketing texts. */
export const EBR_WINDOW_MONTHS = 18

export type WinbackChannel = "sms" | "email" | "none"

export type WinbackCustomer = {
  phone: string | null
  email: string | null
  /** Best evidence of the last real transaction (ISO timestamp), or null. */
  last_transaction_at: string | null
  /** Set when the customer texted STOP / opted out of SMS. */
  sms_opted_out_at: string | null
  /** Owner's manual, immediate, all-channel block. */
  do_not_contact: boolean
}

/** True only if the last transaction is within EBR_WINDOW_MONTHS of `nowMs`. */
export function withinEbrWindow(
  lastTransactionAt: string | null,
  nowMs: number
): boolean {
  if (!lastTransactionAt) return false
  const ts = Date.parse(lastTransactionAt)
  if (Number.isNaN(ts)) return false
  if (ts > nowMs) return true // future-dated → treat as recent, never stale
  const cutoff = new Date(nowMs)
  cutoff.setMonth(cutoff.getMonth() - EBR_WINDOW_MONTHS)
  return ts >= cutoff.getTime()
}

/**
 * The single source of truth for which channel (if any) a recovered customer
 * may be reached on. SMS is the narrow, gated path; everything else falls back
 * to email or nothing.
 */
export function winbackChannel(
  c: WinbackCustomer,
  nowMs: number
): WinbackChannel {
  if (c.do_not_contact) return "none"

  const smsEligible =
    Boolean(c.phone) &&
    !c.sms_opted_out_at &&
    withinEbrWindow(c.last_transaction_at, nowMs)

  if (smsEligible) return "sms"
  if (c.email) return "email"
  return "none"
}

/** Convenience predicate for the audience resolver / locking tests. */
export function isSmsEligibleForWinback(
  c: WinbackCustomer,
  nowMs: number
): boolean {
  return winbackChannel(c, nowMs) === "sms"
}
