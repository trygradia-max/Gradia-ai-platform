/**
 * Trusted caller identity for the voice receptionist.
 *
 * The only identity a call can prove is the telephony caller ID Vapi sends in
 * the webhook's `message.call.customer.number` — the request is authenticated
 * (per-shop x-vapi-secret) before any tool runs. Every phone number the
 * *model* passes as a tool argument is attacker-influenced: a caller can talk
 * the assistant into "look up 503-555-0100". So every customer-bound tool
 * (history lookup, cancel, reschedule, booking, quote, lead) is bound to the
 * normalized caller ID here, and a supplied phone can only ever AGREE with it.
 *
 * Fail closed: missing/blocked caller ID, or a supplied phone that does not
 * match after normalization, yields one uniform non-disclosing refusal — the
 * same sentence for every tool and every reason, so the spoken answer never
 * reveals whether a customer, message, booking or service exists.
 *
 * Deliberately NOT a source of identity: `call.phoneNumber.number` is the
 * shop's own dialed line, never the caller.
 */

import { normalizePhone } from "@/lib/customers"

export type VapiCallContext = {
  id?: string
  /** Raw `call.customer.number` as sent by Vapi; normalize via bindCaller(). */
  callerPhone?: string
  callerName?: string
}

/** One sentence for every refusal reason and every tool (uniform disclosure). */
export const CALLER_IDENTITY_REFUSAL =
  "I can't pull up or change account details from this call — the team will follow up with you directly."

/** Evidence persisted on every staged voice proposal (payload.caller_identity). */
export type CallerIdentityEvidence = {
  /** Where the identity came from — telephony caller ID, never model text. */
  source: "vapi_call_customer_number"
  /** Normalized E.164 caller ID the proposal is bound to. */
  verified_phone: string
  /**
   * What the model supplied: "not_supplied" or "matched". A mismatch is never
   * staged (the call is refused), so "mismatched" cannot appear on a proposal.
   */
  supplied_phone: "not_supplied" | "matched"
  /** Vapi call id the identity was read from, when present. */
  call_id: string | null
}

export type CallerRefusalReason = "caller_id_unavailable" | "phone_mismatch"

export type CallerBinding =
  | { ok: true; phone: string; evidence: CallerIdentityEvidence }
  | { ok: false; reason: CallerRefusalReason }

/**
 * Normalized caller ID from the raw telephony value, or null when it is
 * missing, blocked/anonymous ("anonymous", "restricted", "unknown"…) or not a
 * valid E.164 number. Never guesses a country code.
 */
export function trustedCallerPhone(
  ctx: Pick<VapiCallContext, "callerPhone">
): string | null {
  return normalizePhone(ctx.callerPhone ?? null)
}

/**
 * Does a model-supplied phone denote the caller ID? Exact E.164 after
 * normalization, plus the one lossless national form spoken aloud on a call:
 * a bare 10-digit NANP number for a +1 caller. No other country guessing.
 */
function suppliedMatches(supplied: string, caller: string): boolean {
  const strict = normalizePhone(supplied)
  if (strict) return strict === caller
  if (/[^\d\s().-]/.test(supplied)) return false
  const digits = supplied.replace(/\D/g, "")
  const callerDigits = caller.slice(1)
  if (digits === callerDigits) return true
  return (
    caller.startsWith("+1") && digits.length === 10 && `1${digits}` === callerDigits
  )
}

/**
 * Bind a tool call to the authenticated caller. `supplied` is the model's
 * (untrusted) phone argument, "" when absent. Returns the caller ID to use for
 * every customer lookup/target, or a refusal reason.
 */
export function bindCaller(
  ctx: VapiCallContext,
  supplied: string
): CallerBinding {
  const caller = trustedCallerPhone(ctx)
  if (!caller) return { ok: false, reason: "caller_id_unavailable" }
  const given = supplied.trim()
  if (given && !suppliedMatches(given, caller)) {
    return { ok: false, reason: "phone_mismatch" }
  }
  return {
    ok: true,
    phone: caller,
    evidence: {
      source: "vapi_call_customer_number",
      verified_phone: caller,
      supplied_phone: given ? "matched" : "not_supplied",
      call_id: ctx.id ?? null,
    },
  }
}

/**
 * Structured refusal log. Carries the tool, reason and call id only — never a
 * phone number (PII) from either the caller ID or the model's argument.
 */
export function logCallerRefusal(
  tool: string,
  shopId: string,
  ctx: VapiCallContext,
  reason: CallerRefusalReason
): void {
  console.warn("[voice-identity] refused — tool bound to caller ID", {
    tool,
    shopId,
    reason,
    vapiCallId: ctx.id ?? null,
  })
}

export type CallerIdentityView =
  | { kind: "verified"; phone: string }
  | { kind: "edited"; callerId: string; current: string }
  | { kind: "unrecorded" }

/**
 * What the approval surface may honestly say about a staged proposal. Reads
 * only the persisted evidence: null for non-voice proposals; "unrecorded" for
 * voice proposals staged before caller binding existed (or with evidence that
 * doesn't validate); "edited" when the owner changed the phone away from the
 * verified caller ID after staging.
 */
export function describeCallerIdentity(
  payload: Record<string, unknown> | null | undefined
): CallerIdentityView | null {
  if (!payload || payload.source !== "voice") return null
  const ev = payload.caller_identity as Partial<CallerIdentityEvidence> | undefined
  const verified =
    ev && ev.source === "vapi_call_customer_number"
      ? normalizePhone(ev.verified_phone ?? null)
      : null
  if (!verified) return { kind: "unrecorded" }
  const current = typeof payload.phone === "string" ? payload.phone.trim() : ""
  if (current && normalizePhone(current) !== verified) {
    return { kind: "edited", callerId: verified, current }
  }
  return { kind: "verified", phone: verified }
}
