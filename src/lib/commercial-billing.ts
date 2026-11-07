import {
  APPROVED_COMMERCIAL_CATALOG_VERSION,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"
import { STRIPE_COMMERCIAL_PROVISIONING_MANIFEST } from "@/lib/stripe-commercial-manifest"

/**
 * Pure rules for PLATFORM commercial billing state (Commercial Billing PR C).
 * Sandbox/test mode only. No I/O and no Node-only imports, so the owner UI may
 * import its constants and types. The database and the Stripe client live in
 * other modules; this file decides what a persisted state MEANS.
 *
 * Fail-closed principle: only reviewed, persisted subscription evidence for the
 * exact approved catalog can say "active". Everything else, including a missing
 * or unreadable record, blocks activation.
 */

export const COMMERCIAL_PLAN_KEY = FOUNDER_PILOT_POLICY.planKey
export const COMMERCIAL_CATALOG_VERSION = APPROVED_COMMERCIAL_CATALOG_VERSION

const workspacePrice = STRIPE_COMMERCIAL_PROVISIONING_MANIFEST.recurringPrices.find(
  (price) => price.kind === "workspace_subscription"
)
if (!workspacePrice) throw new Error("Approved workspace subscription price is missing")

/** The only sellable Stripe Price, resolved by lookup key, never by ID or name. */
export const FOUNDER_PILOT_PRICE = {
  lookupKey: workspacePrice.lookupKey,
  unitAmountCents: workspacePrice.unitAmountCents,
  interval: workspacePrice.interval,
  currency: STRIPE_COMMERCIAL_PROVISIONING_MANIFEST.currency,
} as const

export const COMMERCIAL_BILLING_STATES = [
  "unconfigured",
  "checkout_required",
  "checkout_pending",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "unknown",
  "reconciliation_required",
] as const
export type CommercialBillingState = (typeof COMMERCIAL_BILLING_STATES)[number]

export const COMMERCIAL_BLOCKING_REASONS = [
  "billing_unconfigured",
  "billing_misconfigured",
  "return_origin_unconfigured",
  "owner_required",
  "billing_state_unavailable",
  "checkout_required",
  "checkout_in_progress",
  "checkout_completed_awaiting_evidence",
  "checkout_conflict",
  "provider_unavailable",
  "price_verification_failed",
  "subscription_past_due",
  "subscription_canceled",
  "subscription_incomplete",
  "subscription_unknown",
  "catalog_mismatch",
  "customer_mismatch",
  "duplicate_subscription",
  "provider_outcome_unknown",
  // Exact ambiguous-outcome reasons recorded by the database. An ambiguous provider
  // result is never reported as a failure that is safe to retry.
  "customer_outcome_unknown",
  "customer_bind_failed",
  "session_outcome_unknown",
  "session_record_failed",
  "session_binding_mismatch",
  "stale_in_flight",
  "reconciliation_required",
] as const
export type CommercialBlockingReason = (typeof COMMERCIAL_BLOCKING_REASONS)[number]

const reasonSet: ReadonlySet<string> = new Set(COMMERCIAL_BLOCKING_REASONS)
export function isBlockingReason(value: unknown): value is CommercialBlockingReason {
  return typeof value === "string" && reasonSet.has(value)
}

/** Reviewed evidence sources. A redirect or client assertion is not among them. */
export const REVIEWED_EVIDENCE_SOURCES = ["signed_webhook", "reviewed_reconciliation"] as const

/**
 * Allowlisted return targets. The browser may only pick a KEY; the path is owned
 * here and the origin comes from server configuration. No URL is ever accepted
 * from a client.
 */
export const CHECKOUT_RETURN_TARGETS = {
  agents: "/agents",
  billing: "/billing",
} as const
export type CheckoutReturnTarget = keyof typeof CHECKOUT_RETURN_TARGETS

export function isReturnTarget(value: unknown): value is CheckoutReturnTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHECKOUT_RETURN_TARGETS, value)
}

export type CheckoutReturnUrls =
  | { ok: true; successUrl: string; cancelUrl: string }
  | { ok: false; reason: "return_origin_unconfigured" }

/**
 * Builds the success/cancel URLs from the SERVER-configured dashboard origin and
 * an allowlisted target. The success URL deliberately carries no session id and
 * no flag the application trusts: arriving there proves nothing about payment.
 */
export function buildCheckoutReturnUrls(
  configuredOrigin: string | undefined | null,
  target: CheckoutReturnTarget
): CheckoutReturnUrls {
  const raw = configuredOrigin?.trim()
  if (!raw) return { ok: false, reason: "return_origin_unconfigured" }
  let origin: URL
  try {
    origin = new URL(raw)
  } catch {
    return { ok: false, reason: "return_origin_unconfigured" }
  }
  const loopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]"
  if (origin.username || origin.password) return { ok: false, reason: "return_origin_unconfigured" }
  if (origin.protocol !== "https:" && !(loopback && origin.protocol === "http:")) {
    return { ok: false, reason: "return_origin_unconfigured" }
  }
  const path = CHECKOUT_RETURN_TARGETS[target]
  return {
    ok: true,
    successUrl: `${origin.origin}${path}?billing_return=success`,
    cancelUrl: `${origin.origin}${path}?billing_return=canceled`,
  }
}

export type CheckoutRequestIdentity = {
  shopId: string
  catalogVersion: string
  planKey: string
  lookupKey: string
  returnTarget: CheckoutReturnTarget
}

/** Deterministic provider idempotency keys derived from LOCAL identities only. */
export function customerIdempotencyKey(shopId: string): string {
  return `gradia-cb-customer-${shopId}`
}
export function sessionIdempotencyKey(attemptId: string): string {
  return `gradia-cb-session-${attemptId}`
}

// ---------- Persisted snapshot (what the database returns) ----------

export type BillingSnapshot = {
  account: {
    state: CommercialBillingState
    stateReason: string | null
    catalogVersion: string
    planKey: string
    providerMode: string
    hasPlatformCustomer: boolean
    version: number
  } | null
  attempt: {
    id: string
    attemptNo: number
    status: "started" | "session_open" | "completed_unverified" | "expired" | "rejected" | "unknown"
    failureCode: string | null
    sessionId: string | null
  } | null
  evidence: {
    id: string
    derivedState: string
    providerStatus: string
    catalogVersion: string
    planKey: string
    priceLookupKey: string
    evidenceSource: string
    livemode: boolean
  } | null
}

export type BillingEvaluation = {
  state: CommercialBillingState
  /** True only for reviewed, persisted, current-catalog active evidence. */
  eligibleToActivate: boolean
  blockingReason: CommercialBlockingReason | null
}

const stateSet: ReadonlySet<string> = new Set(COMMERCIAL_BILLING_STATES)

function reasonFromStored(stored: string | null, fallback: CommercialBlockingReason): CommercialBlockingReason {
  return isBlockingReason(stored) ? stored : fallback
}

/**
 * Decides what a persisted snapshot means for activation. `null` means the read
 * itself failed (unknown, never "no account"); `{ account: null }` means the
 * read succeeded and no billing was ever requested.
 */
export function evaluateBillingSnapshot(snapshot: BillingSnapshot | null): BillingEvaluation {
  if (!snapshot) {
    return { state: "unknown", eligibleToActivate: false, blockingReason: "billing_state_unavailable" }
  }
  const { account, evidence } = snapshot
  if (!account) {
    return { state: "checkout_required", eligibleToActivate: false, blockingReason: "checkout_required" }
  }
  if (!stateSet.has(account.state)) {
    return { state: "unknown", eligibleToActivate: false, blockingReason: "subscription_unknown" }
  }
  if (account.catalogVersion !== COMMERCIAL_CATALOG_VERSION || account.planKey !== COMMERCIAL_PLAN_KEY) {
    return { state: "reconciliation_required", eligibleToActivate: false, blockingReason: "catalog_mismatch" }
  }
  switch (account.state) {
    case "active": {
      const reviewed =
        evidence !== null &&
        evidence.derivedState === "active" &&
        evidence.providerStatus === "active" &&
        evidence.livemode === false &&
        evidence.catalogVersion === COMMERCIAL_CATALOG_VERSION &&
        evidence.planKey === COMMERCIAL_PLAN_KEY &&
        evidence.priceLookupKey === FOUNDER_PILOT_PRICE.lookupKey &&
        (REVIEWED_EVIDENCE_SOURCES as readonly string[]).includes(evidence.evidenceSource) &&
        account.providerMode === "test"
      if (!reviewed) {
        const mismatch =
          evidence !== null && (evidence.catalogVersion !== COMMERCIAL_CATALOG_VERSION || evidence.planKey !== COMMERCIAL_PLAN_KEY)
        return {
          state: "reconciliation_required",
          eligibleToActivate: false,
          blockingReason: mismatch ? "catalog_mismatch" : "reconciliation_required",
        }
      }
      return { state: "active", eligibleToActivate: true, blockingReason: null }
    }
    case "checkout_required":
      return { state: "checkout_required", eligibleToActivate: false, blockingReason: "checkout_required" }
    case "checkout_pending":
      return {
        state: "checkout_pending",
        eligibleToActivate: false,
        // An open session means the person must go to Checkout; otherwise a
        // request is still being created or a completed session awaits evidence.
        blockingReason: reasonFromStored(
          account.stateReason,
          snapshot.attempt?.status === "session_open" ? "checkout_required" : "checkout_in_progress"
        ),
      }
    case "past_due":
      return { state: "past_due", eligibleToActivate: false, blockingReason: "subscription_past_due" }
    case "canceled":
      return { state: "canceled", eligibleToActivate: false, blockingReason: "subscription_canceled" }
    case "incomplete":
      return { state: "incomplete", eligibleToActivate: false, blockingReason: "subscription_incomplete" }
    case "reconciliation_required":
      return {
        state: "reconciliation_required",
        eligibleToActivate: false,
        blockingReason: reasonFromStored(account.stateReason, "reconciliation_required"),
      }
    case "unconfigured":
      return { state: "unconfigured", eligibleToActivate: false, blockingReason: "billing_unconfigured" }
    case "unknown":
    default:
      return { state: "unknown", eligibleToActivate: false, blockingReason: "subscription_unknown" }
  }
}

// ---------- DTO consumed by the owner UI (Cursor) ----------

/**
 * Minimal, serializable billing view. `checkoutUrl` is present only when a live,
 * server-created Checkout Session exists for the current attempt. It is never
 * logged and never stored in the database.
 */
export type CommercialBillingDto = {
  state: CommercialBillingState
  eligibleToActivate: boolean
  blockingReason: CommercialBlockingReason | null
  checkoutUrl: string | null
  catalogVersion: typeof COMMERCIAL_CATALOG_VERSION
  planKey: typeof COMMERCIAL_PLAN_KEY
  providerMode: "test"
}

export function billingDto(
  evaluation: BillingEvaluation,
  checkoutUrl: string | null = null
): CommercialBillingDto {
  return {
    state: evaluation.state,
    eligibleToActivate: evaluation.eligibleToActivate,
    blockingReason: evaluation.blockingReason,
    // A URL is only ever shown while the person genuinely needs to go to Checkout.
    checkoutUrl: evaluation.eligibleToActivate ? null : checkoutUrl,
    catalogVersion: COMMERCIAL_CATALOG_VERSION,
    planKey: COMMERCIAL_PLAN_KEY,
    providerMode: "test",
  }
}

export function blockedDto(
  state: CommercialBillingState,
  reason: CommercialBlockingReason
): CommercialBillingDto {
  return billingDto({ state, eligibleToActivate: false, blockingReason: reason })
}
