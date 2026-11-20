import { createHash } from "node:crypto"

import { normalizeSubscription } from "@/lib/commercial-webhook"
import { COMMERCIAL_METER_API_VERSION } from "@/lib/stripe-sandbox-contract"
import { stripeCommercialRequest, type CommercialStripeTransportConfig } from "@/lib/stripe"

/**
 * Polling reconciliation of subscription state (Commercial Billing PR F3). Sandbox/test mode only.
 *
 * Purpose: when signed Stripe webhooks stop arriving, compare what Stripe REPORTS for the subscription the SERVER already binds
 * to a shop with what the database holds, and hand any difference to the database's one subscription writer. This module is the
 * pure half: a GET-only provider reader and a deterministic decision. It does no database work and creates, changes and
 * deletes nothing at the provider.
 *
 * Contract (each line is enforced here AND, as defense in depth, by `commercial_subscription_poll_record`):
 *  - The tenant, the platform customer, the known subscription and the Checkout session/attempt are SERVER-HELD inputs from the
 *    claim. Nothing the provider returns selects a tenant; a metadata `shop_id` is only a cross-check, and the Checkout attempt id
 *    in metadata is discarded.
 *  - The provider's answer must be COMPLETE (list not truncated, items not truncated), TEST-mode, about the bound customer.
 *    Anything else is `ambiguous` and changes nothing.
 *  - A never-seen subscription is accepted only when the server-held Checkout session itself reported it.
 *  - `active` is never produced from ambiguous evidence: an unverified or already-elapsed period, a truncated read, or any other
 *    live subscription on the same customer (a possible duplicate) is `ambiguous`. A MORE RESTRICTIVE state (past_due, canceled,
 *    incomplete, unknown) is still reported, because blocking new paid work is the fail-closed direction.
 *  - The same normalizer as the signed webhook judges the subscription (exact Founder Pilot item set, agreeing periods).
 */

export const POLL_SKEW_MARGIN_SECONDS = 300

/** Statuses the evidence table can hold. Anything else is `ambiguous`, never guessed. */
const SUBSCRIPTION_STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"])
/** A subscription in one of these is finished: it cannot be a second live subscription. */
const FINISHED_STATUSES = new Set(["canceled", "incomplete_expired"])

const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{4,120}$/
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{4,120}$/
const SESSION_ID = /^cs_test_[A-Za-z0-9_]{4,200}$/

// ---------- observation (exactly what the database records) ----------

export type PollNoneClass = "no_subscription" | "session_pending" | "ambiguous"

export type PollObservation =
  | { kind: "subscription"; customer_id: string; session_subscription_id: string | null; facts: Record<string, unknown> }
  | { kind: "none"; customer_id: string; class: PollNoneClass; code: string }
  | { kind: "unreadable"; customer_id: string; code: string }

/** Stable JSON (sorted keys) so the same observation always has the same digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** The replay fingerprint of an observation: sha256 over its canonical form. Nothing secret or payload-sized is in it. */
export function observationDigest(observation: PollObservation): string {
  return createHash("sha256").update(canonical(observation), "utf8").digest("hex")
}

// ---------- provider reader (GET only) ----------

export type PolledList = { complete: boolean; data: unknown[] }

export type SubscriptionPollReader = {
  /** Every subscription (any status) the provider holds for ONE customer. Read-only. Throws on any transport failure. */
  listCustomerSubscriptions(customerId: string): Promise<PolledList>
  /** One Checkout Session by its server-held id. Read-only. Throws on any transport failure. */
  retrieveCheckoutSession(sessionId: string): Promise<unknown>
}

type ListEnvelope = { data?: unknown; has_more?: unknown }

/**
 * GET-only reader over the shared commercial transport (PLATFORM account, the reviewed API version, the refused-if-live PR C
 * configuration). The method type admits nothing but GET, so no mutating call can be expressed here.
 */
export function createSubscriptionPollReader(
  config: CommercialStripeTransportConfig,
  request: typeof stripeCommercialRequest = stripeCommercialRequest
): SubscriptionPollReader {
  const get = <T>(path: string, body?: Record<string, string | number>) =>
    request<T>(config, { method: "GET", path, body, apiVersion: COMMERCIAL_METER_API_VERSION })
  return {
    async listCustomerSubscriptions(customerId) {
      if (!CUSTOMER_ID.test(customerId)) throw new Error("invalid_customer")
      // `customer` is required for the provider to show test-clock objects at all; `status=all` includes canceled ones.
      const list = await get<ListEnvelope>("/subscriptions", { customer: customerId, status: "all", limit: 100 })
      if (!Array.isArray(list.data)) throw new Error("list_unreadable")
      return { complete: list.has_more === false, data: list.data }
    },
    async retrieveCheckoutSession(sessionId) {
      if (!SESSION_ID.test(sessionId)) throw new Error("invalid_session")
      return get<unknown>(`/checkout/sessions/${encodeURIComponent(sessionId)}`)
    },
  }
}

// ---------- decisions (pure) ----------

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const idOf = (value: unknown): string | null => {
  if (typeof value === "string") return value
  const object = record(value)
  return object && typeof object.id === "string" ? object.id : null
}

export type SessionInterpretation =
  | { kind: "complete"; subscriptionId: string }
  | { kind: "pending"; code: "session_open" | "session_expired" }
  | { kind: "ambiguous"; code: string }

/**
 * Interprets the server-held Checkout session. It must be this attempt's session (client reference), subscription mode, TEST
 * mode and bound to the platform customer; metadata is not consulted. Only a COMPLETE session names a subscription.
 */
export function interpretCheckoutSession(
  raw: unknown,
  expected: { sessionId: string; attemptId: string; customerId: string }
): SessionInterpretation {
  const session = record(raw)
  if (!session || session.object !== "checkout.session") return { kind: "ambiguous", code: "session_unreadable" }
  if (session.livemode !== false) return { kind: "ambiguous", code: "live_object_refused" }
  if (session.id !== expected.sessionId || session.mode !== "subscription") return { kind: "ambiguous", code: "session_binding_mismatch" }
  if (session.client_reference_id !== expected.attemptId || idOf(session.customer) !== expected.customerId) {
    return { kind: "ambiguous", code: "session_binding_mismatch" }
  }
  if (session.status === "open") return { kind: "pending", code: "session_open" }
  if (session.status === "expired") return { kind: "pending", code: "session_expired" }
  if (session.status !== "complete") return { kind: "ambiguous", code: "session_unreadable" }
  const subscriptionId = idOf(session.subscription)
  if (!subscriptionId || !SUBSCRIPTION_ID.test(subscriptionId)) return { kind: "ambiguous", code: "session_subscription_missing" }
  return { kind: "complete", subscriptionId }
}

const ambiguous = (customerId: string, code: string): PollObservation => ({ kind: "none", customer_id: customerId, class: "ambiguous", code })

/**
 * Judges a COMPLETE provider list for one customer against the server-held target subscription and returns the observation to
 * record. Never throws. See the contract in the file header.
 */
export function decideSubscriptionObservation(input: {
  customerId: string
  /** The server-held subscription to compare: the account's current evidence subscription, or the one the Checkout session named. */
  targetSubscriptionId: string
  /** Set only when the target came from the server-held Checkout session (a subscription this shop has never recorded). */
  sessionSubscriptionId: string | null
  list: PolledList
  nowMs: number
}): PollObservation {
  const { customerId, targetSubscriptionId } = input
  if (!input.list.complete) return ambiguous(customerId, "list_incomplete")

  let target: Record<string, unknown> | null = null
  let otherLive = false
  for (const raw of input.list.data) {
    const subscription = record(raw)
    const id = subscription ? idOf(subscription.id) : null
    if (!subscription || subscription.object !== "subscription" || !id || !SUBSCRIPTION_ID.test(id)) return ambiguous(customerId, "subscription_unreadable")
    if (subscription.livemode !== false) return ambiguous(customerId, "live_object_refused")
    if (idOf(subscription.customer) !== customerId) return ambiguous(customerId, "customer_mismatch")
    if (id === targetSubscriptionId) {
      if (target) return ambiguous(customerId, "subscription_duplicated")
      target = subscription
    } else if (typeof subscription.status !== "string" || !FINISHED_STATUSES.has(subscription.status)) {
      // Any other subscription that is not provably finished (an unreadable status counts as live) is a possible duplicate.
      otherLive = true
    }
  }
  if (!target) return ambiguous(customerId, "target_missing")

  const items = record(target.items)
  if (!items || !Array.isArray(items.data) || items.has_more !== false) return ambiguous(customerId, "items_incomplete")

  const facts = normalizeSubscription(target)
  if (!facts) return ambiguous(customerId, "subscription_unreadable")
  const status = typeof facts.status === "string" ? facts.status : ""
  if (!SUBSCRIPTION_STATUSES.has(status)) return ambiguous(customerId, "status_unrecognized")
  // The attempt id in provider metadata is NEVER used: the attempt comes only from the server-held claim.
  const safeFacts = { ...facts, checkout_attempt_id: null }

  if (status === "active") {
    if (otherLive) return ambiguous(customerId, "unexpected_subscription")
    if (facts.period_start === null || facts.period_end === null || facts.started_at === null) return ambiguous(customerId, "period_not_verified")
    if (Date.parse(String(facts.period_end)) <= input.nowMs) return ambiguous(customerId, "period_elapsed")
  }
  return { kind: "subscription", customer_id: customerId, session_subscription_id: input.sessionSubscriptionId, facts: safeFacts }
}

export const noSubscription = (customerId: string, code = "nothing_to_compare"): PollObservation => ({
  kind: "none", customer_id: customerId, class: "no_subscription", code,
})
export const sessionPending = (customerId: string, code: "session_open" | "session_expired"): PollObservation => ({
  kind: "none", customer_id: customerId, class: "session_pending", code,
})
export const unreadable = (customerId: string, code = "provider_unreadable"): PollObservation => ({
  kind: "unreadable", customer_id: customerId, code,
})
export { ambiguous as ambiguousObservation }
