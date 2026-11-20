import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  ambiguousObservation,
  decideSubscriptionObservation,
  interpretCheckoutSession,
  noSubscription,
  observationDigest,
  sessionPending,
  unreadable,
  type PollObservation,
  type SubscriptionPollReader,
} from "@/lib/commercial-subscription-poll"
import type { ItemGate } from "@/lib/commercial-billing-operations"

/**
 * Database orchestration for polling reconciliation of subscription state (Commercial Billing PR F3). Service role only; a system
 * actor, never a request.
 *
 *   claim  -> the database hands out ONE due shop (rate limit + per-shop mutex); tenant, customer, known subscription and the
 *             Checkout attempt are server-held values returned by the claim
 *   read   -> GET-only provider reads for that customer (never a write, never a resend)
 *   decide -> the pure rules in `commercial-subscription-poll.ts`
 *   record -> ONE database call: replay-safe per claim, and the only path to the single subscription writer
 *
 * A crash anywhere leaves at most an expired claim (the shop backs off and is polled again). Nothing here can create a
 * settlement, adjustment, refund, credit, cancellation, retry or payment, or mark anything paid by itself.
 */

const claimSchema = z.discriminatedUnion("claimed", [
  z.object({
    claimed: z.literal(true),
    claim_token: z.string().uuid(),
    shop_id: z.string().uuid(),
    customer_id: z.string().regex(/^cus_[A-Za-z0-9_]{4,120}$/),
    state: z.string(),
    known_subscription_id: z.string().regex(/^sub_[A-Za-z0-9_]{4,120}$/).nullable(),
    attempt_id: z.string().uuid().nullable(),
    session_id: z.string().regex(/^cs_test_[A-Za-z0-9_]{4,200}$/).nullable(),
    requested_at: z.string(),
    observed_at: z.string(),
  }),
  z.object({ claimed: z.literal(false), reason: z.string() }),
])
export type SubscriptionPollClaim = Extract<z.infer<typeof claimSchema>, { claimed: true }>

const OUTCOMES = ["applied", "not_current", "unchanged", "no_subscription", "session_pending", "ambiguous", "unreadable", "refused"] as const
export type PollOutcome = (typeof OUTCOMES)[number]

const recordSchema = z.object({
  outcome: z.enum(OUTCOMES),
  reason: z.string().nullable().optional(),
  replayed: z.boolean(),
})

const overviewSchema = z.object({
  eligible: z.number().int(),
  due: z.number().int(),
  claimed: z.number().int(),
  never_polled: z.number().int(),
  failing: z.number().int(),
  overdue: z.number().int(),
})

export type PollItemReport = { outcome: PollOutcome; code?: string } | { outcome: "record_failed"; code: "claim_lost" | "record_failed" }

export type SubscriptionPollReport = {
  /** True when the gate stopped the sweep early; the remainder is picked up by the next run. */
  stoppedEarly?: true
  claimed: number
  outcomes: Record<PollOutcome, number>
  recordFailed: number
  claimFailed: boolean
  /** Eligible shops whose next poll is more than an hour late (a stuck or starved poll). Counts only. */
  overdue: number
  /** Eligible shops currently backing off after an ambiguous / unreadable / refused poll. */
  failing: number
}

const emptyOutcomes = (): Record<PollOutcome, number> => ({
  applied: 0, not_current: 0, unchanged: 0, no_subscription: 0, session_pending: 0, ambiguous: 0, unreadable: 0, refused: 0,
})

/** Gathers the provider evidence for one claim. Never throws: an unreadable provider is an `unreadable` observation. */
export async function observeClaim(
  reader: SubscriptionPollReader,
  claim: Pick<SubscriptionPollClaim, "customer_id" | "known_subscription_id" | "attempt_id" | "session_id">,
  nowMs: number
): Promise<PollObservation> {
  const customerId = claim.customer_id
  try {
    if (claim.known_subscription_id) {
      const list = await reader.listCustomerSubscriptions(customerId)
      return decideSubscriptionObservation({ customerId, targetSubscriptionId: claim.known_subscription_id, sessionSubscriptionId: null, list, nowMs })
    }
    // A subscription this shop has never recorded: only the server-held Checkout session may name it.
    if (!claim.session_id || !claim.attempt_id) return noSubscription(customerId)
    const session = interpretCheckoutSession(await reader.retrieveCheckoutSession(claim.session_id), {
      sessionId: claim.session_id,
      attemptId: claim.attempt_id,
      customerId,
    })
    if (session.kind === "pending") return sessionPending(customerId, session.code)
    if (session.kind === "ambiguous") return ambiguousObservation(customerId, session.code)
    const list = await reader.listCustomerSubscriptions(customerId)
    return decideSubscriptionObservation({
      customerId,
      targetSubscriptionId: session.subscriptionId,
      sessionSubscriptionId: session.subscriptionId,
      list,
      nowMs,
    })
  } catch {
    // The error text could carry configuration; only a finite code is kept. The shop backs off and is polled again.
    return unreadable(customerId)
  }
}

export async function claimNextSubscriptionPoll(
  service: SupabaseClient,
  options: { shopId?: string; ttlSeconds?: number } = {}
): Promise<{ ok: true; claim: SubscriptionPollClaim | null } | { ok: false }> {
  const { data, error } = await service.rpc("commercial_subscription_poll_claim", {
    p_shop: options.shopId ?? null,
    p_ttl_seconds: options.ttlSeconds ?? 120,
  })
  const parsed = claimSchema.safeParse(data)
  if (error || !parsed.success) return { ok: false }
  return { ok: true, claim: parsed.data.claimed ? parsed.data : null }
}

/** Records one observation against its claim (idempotent per claim). The database re-validates everything. */
export async function recordSubscriptionPoll(
  service: SupabaseClient,
  claim: Pick<SubscriptionPollClaim, "shop_id" | "claim_token">,
  observation: PollObservation
): Promise<PollItemReport> {
  const { data, error } = await service.rpc("commercial_subscription_poll_record", {
    p_shop: claim.shop_id,
    p_claim_token: claim.claim_token,
    p_observation: { ...observation, digest: observationDigest(observation) },
  })
  if (error) return { outcome: "record_failed", code: error.code === "CB409" ? "claim_lost" : "record_failed" }
  const parsed = recordSchema.safeParse(data)
  if (!parsed.success) return { outcome: "record_failed", code: "record_failed" }
  return { outcome: parsed.data.outcome, ...(parsed.data.reason ? { code: parsed.data.reason } : {}) }
}

export async function runSubscriptionPollSweep(
  service: SupabaseClient,
  reader: SubscriptionPollReader,
  options: { limit?: number; shopId?: string; gate?: ItemGate; nowMs?: () => number } = {}
): Promise<SubscriptionPollReport> {
  const limit = options.limit ?? 10
  const now = options.nowMs ?? Date.now
  const report: SubscriptionPollReport = { claimed: 0, outcomes: emptyOutcomes(), recordFailed: 0, claimFailed: false, overdue: 0, failing: 0 }
  for (let i = 0; i < limit; i++) {
    if (options.gate && !(await options.gate())) {
      report.stoppedEarly = true
      break
    }
    const claimed = await claimNextSubscriptionPoll(service, { shopId: options.shopId })
    if (!claimed.ok) {
      report.claimFailed = true
      break
    }
    if (!claimed.claim) break
    report.claimed++
    const observation = await observeClaim(reader, claimed.claim, now())
    const result = await recordSubscriptionPoll(service, claimed.claim, observation)
    if (result.outcome === "record_failed") report.recordFailed++
    else report.outcomes[result.outcome]++
  }
  // Observability: counts only (never an id, token, customer or payload).
  const overview = await service.rpc("commercial_subscription_poll_overview")
  const parsed = overviewSchema.safeParse(overview.data)
  if (!overview.error && parsed.success) {
    report.overdue = parsed.data.overdue
    report.failing = parsed.data.failing
  }
  return report
}
