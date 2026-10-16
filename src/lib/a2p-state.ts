import type { A2pRegistrationRow, A2pRegistrationStep } from "@/lib/types/database"

/**
 * What the owner can do about SMS registration right now — the published
 * contract the Settings wizard renders (docs/architecture/CHANNEL_PROVIDERS.md).
 * Derived only from the stored row; no vendor calls.
 *
 *   submit            nothing submitted yet
 *   resume            a submission stopped on a temporary problem; resubmitting
 *                     the same details continues after the last completed step
 *   fix_and_resubmit  carriers or Twilio refused the details; edit, then submit
 *   resubmit_campaign carriers rejected only the campaign; the approved brand is
 *                     kept and a new campaign is created on resubmit
 *   wait              with carriers; check status (a temporary problem in a
 *                     later step is retried automatically on the next check)
 *   none              approved: texting is open
 */
export type A2pNextAction = "submit" | "resume" | "fix_and_resubmit" | "resubmit_campaign" | "wait" | "none"

export type A2pRegistrationState = {
  status: A2pRegistrationRow["status"] | "none"
  nextAction: A2pNextAction
  failedStep: A2pRegistrationStep | null
  retryable: boolean | null
  failureReason: string | null
  attempts: number
}

type RowFields = Pick<A2pRegistrationRow, "status" | "failed_step" | "retryable" | "failure_reason" | "attempts">

export function describeA2pRegistration(reg: RowFields | null): A2pRegistrationState {
  if (!reg) return { status: "none", nextAction: "submit", failedStep: null, retryable: null, failureReason: null, attempts: 0 }
  const base = { status: reg.status, failedStep: reg.failed_step, retryable: reg.retryable, failureReason: reg.failure_reason, attempts: reg.attempts ?? 0 }
  switch (reg.status) {
    case "approved":
      return { ...base, nextAction: "none" }
    case "brand_pending":
    case "campaign_pending":
      return { ...base, nextAction: "wait" }
    case "rejected":
      return { ...base, nextAction: reg.failed_step === "campaign" ? "resubmit_campaign" : "fix_and_resubmit" }
    case "draft":
      if (!reg.failed_step) return { ...base, nextAction: "submit" }
      return { ...base, nextAction: reg.retryable === false ? "fix_and_resubmit" : "resume" }
  }
}

/** Order-insensitive comparison of submitted business details. */
export function sameBusinessDetails(a: unknown, b: unknown): boolean {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
      : v
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b))
}
