/**
 * Voice test call guard (security audit run-1, finding #6).
 *
 * `requestVoiceTestCall` used to ring ANY +1 number the signed-in owner typed, with no proof of
 * entitlement, remaining minutes, rate or that the number was theirs: a toll-fraud / harassment
 * primitive billed to Gradia's Vapi account. This module is now the only way to reach Vapi's
 * outbound-call endpoint for a test call, and it refuses unless ALL of these hold, in order:
 *
 *   1. The shop is owned by the signed-in user (re-read from the database by id + owner_id; the
 *      shop id comes from the owner session, never from the request).
 *   2. Current Voice entitlement: `hasPackage2` (plan active AND voice add-on).
 *   3. Operational readiness: saved assistant, connected Vapi number, a server-written Gradia
 *      number, and an assistant that is not stale.
 *   4. A destination whose ownership is proven by trusted evidence: the signed-in user's own
 *      Supabase Auth phone, present only after Supabase's SMS one-time-code confirmation
 *      (`phone_confirmed_at`). The caller supplies NO destination. `shops.phone`,
 *      `voice_config.escalation_phone` and anything in a form are owner-editable and are never
 *      proof. If no confirmed phone exists the call is refused (fail closed).
 *   5. Remaining voice minutes this month (`voiceBudgetState`, failing CLOSED on a usage-query
 *      error, unlike the webhook's fail-open read).
 *   6. The atomic database claim (`voice_test_call_claim`): one in-flight attempt per shop, a
 *      minimum interval, and per-hour / per-day ceilings. Every attempt counts.
 *
 * After the claim, 1-5 are re-read from the database and re-evaluated immediately before the
 * provider call, so a cancellation, budget exhaustion or phone change during the window is caught.
 * Nothing here contacts Vapi except through `startVoiceTestCall` with a minted authorization.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { hasPackage2 } from "@/lib/entitlements"
import { STRINGS } from "@/lib/strings"
import { createServiceClient } from "@/lib/supabase/service"
import type { ShopRow } from "@/lib/types/database"
import { mintVoiceTestCallAuthorization } from "@/lib/voice-test-call-authorization"
import { startVoiceTestCall, voiceBudgetState, type PlaceOutboundCall } from "@/lib/voice-provider"

/** Deterministic, code-owned limits (not owner-editable, not env-tunable). */
export const VOICE_TEST_CALL_LIMITS = {
  minIntervalSeconds: 60,
  inflightSeconds: 180,
  perHour: 3,
  perDay: 6,
} as const

export type VoiceTestCallRefusal =
  | "not_found"
  | "not_entitled"
  | "not_ready"
  | "stale"
  | "no_verified_phone"
  | "budget_exhausted"
  | "in_progress"
  | "too_soon"
  | "rate_limited"
  | "unavailable"
  | "provider_failed"

const REFUSAL_COPY: Record<VoiceTestCallRefusal, string> = {
  not_found: "Finish onboarding first.",
  not_entitled: STRINGS.voiceTestCall.needsVoiceAddon,
  not_ready: STRINGS.voiceTestCall.notReady,
  stale: STRINGS.voiceTestCall.stale,
  no_verified_phone: STRINGS.voiceTestCall.needsVerifiedPhone,
  budget_exhausted: STRINGS.voiceTestCall.budgetExhausted,
  in_progress: STRINGS.voiceTestCall.inProgress,
  too_soon: STRINGS.voiceTestCall.tooSoon,
  rate_limited: STRINGS.voiceTestCall.rateLimited,
  unavailable: STRINGS.voiceTestCall.unavailable,
  provider_failed: STRINGS.voiceTestCall.placeFailed,
}

export function voiceTestCallRefusalMessage(reason: VoiceTestCallRefusal): string {
  return REFUSAL_COPY[reason]
}

export type VoiceTestCallOutcome =
  | { ok: true }
  | { ok: false; reason: VoiceTestCallRefusal; error: string }

const refuse = (reason: VoiceTestCallRefusal): { ok: false; reason: VoiceTestCallRefusal; error: string } => ({
  ok: false,
  reason,
  error: REFUSAL_COPY[reason],
})

export type AuthPhoneEvidence = {
  phone?: string | null
  phone_confirmed_at?: string | null
} | null

/**
 * The trusted destination, from Supabase Auth only: the number is present in `phone` and
 * `phone_confirmed_at` is set only after the user confirmed an SMS code sent to it. Returns
 * strict NANP E.164 or null.
 */
export function verifiedPhoneFromAuthUser(user: AuthPhoneEvidence): string | null {
  if (!user?.phone || !user.phone_confirmed_at) return null
  if (Number.isNaN(Date.parse(user.phone_confirmed_at))) return null
  const digits = user.phone.startsWith("+") ? user.phone.slice(1) : user.phone
  if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null
  return `+${digits}`
}

export function maskPhone(e164: string): string {
  return `+1 ••• ••• ${e164.slice(-4)}`
}

export type VoiceTestCallDeps = {
  /** Service-role client: every read here is by explicit id + owner. */
  service: SupabaseClient
  /** Trusted phone evidence for the signed-in user. Throws on an outage (treated as unavailable). */
  getAuthUser: (userId: string) => Promise<AuthPhoneEvidence>
  /** Defaults to the real provider call inside `startVoiceTestCall`; tests inject a mock. */
  placeCall?: PlaceOutboundCall
  now: () => Date
}

function defaultDeps(): VoiceTestCallDeps {
  const service = createServiceClient()
  return {
    service,
    getAuthUser: async (userId) => {
      const { data, error } = await service.auth.admin.getUserById(userId)
      if (error) throw error
      return data.user ?? null
    },
    now: () => new Date(),
  }
}

type ControlsResult =
  | { ok: true; shop: ShopRow; toNumber: string }
  | { ok: false; reason: VoiceTestCallRefusal }

/** Reads everything fresh and evaluates controls 1-5. Pure of side effects. */
async function evaluateControls(
  deps: VoiceTestCallDeps,
  who: { userId: string; shopId: string }
): Promise<ControlsResult> {
  try {
    const { data, error } = await deps.service
      .from("shops")
      .select("*")
      .eq("id", who.shopId)
      .eq("owner_id", who.userId)
      .maybeSingle()
    if (error) return { ok: false, reason: "unavailable" }
    const shop = data as ShopRow | null
    if (!shop) return { ok: false, reason: "not_found" }

    if (!hasPackage2(shop)) return { ok: false, reason: "not_entitled" }
    if (!shop.vapi_assistant_id || !shop.vapi_phone_number_id || !shop.gradia_number_e164) {
      return { ok: false, reason: "not_ready" }
    }
    if (shop.vapi_stale) return { ok: false, reason: "stale" }

    const toNumber = verifiedPhoneFromAuthUser(await deps.getAuthUser(who.userId))
    // A call to the shop's own number would loop the receptionist into itself.
    if (!toNumber || toNumber === shop.gradia_number_e164) {
      return { ok: false, reason: "no_verified_phone" }
    }

    const budget = await voiceBudgetState(deps.service, shop, deps.now(), { failClosed: true })
    if (budget.over || !(budget.budget && budget.budget > 0)) {
      return { ok: false, reason: "budget_exhausted" }
    }
    return { ok: true, shop, toNumber }
  } catch (err) {
    console.error("[voice] test-call control check failed:", err)
    return { ok: false, reason: "unavailable" }
  }
}

export type VoiceTestCallPreflight =
  | { available: true; maskedPhone: string }
  | { available: false; reason: VoiceTestCallRefusal; message: string }

/** What the settings UI shows. Same controls as the action, minus the rate claim. */
export async function getVoiceTestCallPreflight(
  who: { userId: string; shopId: string },
  deps: VoiceTestCallDeps = defaultDeps()
): Promise<VoiceTestCallPreflight> {
  const result = await evaluateControls(deps, who)
  if (!result.ok) {
    return { available: false, reason: result.reason, message: REFUSAL_COPY[result.reason] }
  }
  return { available: true, maskedPhone: maskPhone(result.toNumber) }
}

type ClaimResponse =
  | { ok: true; attempt_id: string }
  | { ok: false; reason: "not_found" | "not_entitled" | "in_progress" | "too_soon" | "rate_limited" }

async function finishAttempt(
  deps: VoiceTestCallDeps,
  attemptId: string,
  status: "dispatched" | "failed" | "aborted"
): Promise<void> {
  const { error } = await deps.service
    .from("voice_test_call_attempts")
    .update({ status, finished_at: deps.now().toISOString() })
    .eq("id", attemptId)
  // The claim row still counts toward the ceilings and expires from in-flight on its own.
  if (error) console.error("[voice] test-call attempt finish failed:", error)
}

/** Places a voice test call to the signed-in owner's verified phone, or refuses. */
export async function runVoiceTestCall(
  who: { userId: string; shopId: string },
  deps: VoiceTestCallDeps = defaultDeps()
): Promise<VoiceTestCallOutcome> {
  const first = await evaluateControls(deps, who)
  if (!first.ok) return refuse(first.reason)

  const limits = VOICE_TEST_CALL_LIMITS
  const { data: claimData, error: claimError } = await deps.service.rpc("voice_test_call_claim", {
    p_shop_id: who.shopId,
    p_user_id: who.userId,
    p_destination_last4: first.toNumber.slice(-4),
    p_min_interval_seconds: limits.minIntervalSeconds,
    p_inflight_seconds: limits.inflightSeconds,
    p_hour_limit: limits.perHour,
    p_day_limit: limits.perDay,
  })
  const claim = claimData as ClaimResponse | null
  if (claimError || !claim || typeof claim !== "object") return refuse("unavailable")
  if (!claim.ok) {
    return refuse(
      claim.reason === "not_found" || claim.reason === "not_entitled" || claim.reason === "in_progress" ||
        claim.reason === "too_soon" || claim.reason === "rate_limited"
        ? claim.reason
        : "unavailable"
    )
  }
  if (typeof claim.attempt_id !== "string" || !claim.attempt_id) return refuse("unavailable")
  const attemptId = claim.attempt_id

  // Recheck immediately before the provider call: state may have changed while we waited.
  const second = await evaluateControls(deps, who)
  if (!second.ok || second.toNumber !== first.toNumber) {
    await finishAttempt(deps, attemptId, "aborted")
    return refuse(second.ok ? "no_verified_phone" : second.reason)
  }

  const result = await startVoiceTestCall({
    supabase: deps.service,
    shop: second.shop,
    authorization: mintVoiceTestCallAuthorization({ toNumber: second.toNumber, attemptId }),
    placeCall: deps.placeCall,
  })
  await finishAttempt(deps, attemptId, result.ok ? "dispatched" : "failed")
  return result.ok ? { ok: true } : refuse("provider_failed")
}
