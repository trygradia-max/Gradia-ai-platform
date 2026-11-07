import { createHash } from "node:crypto"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  COMMERCIAL_BILLING_STATES,
  COMMERCIAL_CATALOG_VERSION,
  COMMERCIAL_PLAN_KEY,
  FOUNDER_PILOT_PRICE,
  billingDto,
  blockedDto,
  buildCheckoutReturnUrls,
  customerIdempotencyKey,
  evaluateBillingSnapshot,
  isReturnTarget,
  sessionIdempotencyKey,
  type BillingSnapshot,
  type CheckoutRequestIdentity,
  type CheckoutReturnTarget,
  type CommercialBillingDto,
} from "@/lib/commercial-billing"
import {
  createPlatformStripeClient,
  isDefinitiveRejection,
  resolveCommercialStripeConfig,
  type PlatformStripeClient,
} from "@/lib/stripe-commercial"

/**
 * Server-side orchestration for the Founder Pilot Checkout handoff (sandbox only).
 *
 * Authority is derived on the server and re-verified by the database:
 *   - writers use a SERVICE-ROLE client and name the acting user; the database
 *     refuses anyone who is not a live, active owner of that exact shop;
 *   - the reader works with an owner SESSION client (or the service role).
 * A Checkout redirect, a client assertion or the creation of a Session never
 * makes a subscription active: only reviewed persisted evidence does (PR E).
 */

export type BillingRuntime =
  | { ok: true; stripe: PlatformStripeClient; returnOrigin: string | null }
  | { ok: false; reason: "billing_unconfigured" | "billing_misconfigured" }

/** Disabled unless the sandbox configuration is complete and test-shaped. */
export function resolveBillingRuntime(
  env: Record<string, string | undefined> = process.env
): BillingRuntime {
  const resolved = resolveCommercialStripeConfig(env)
  if (!resolved.ok) return resolved
  return {
    ok: true,
    stripe: createPlatformStripeClient(resolved.config),
    returnOrigin: resolved.returnOrigin,
  }
}

/** Stable identity of a Checkout request. A changed request has a changed value. */
export function checkoutRequestFingerprint(identity: CheckoutRequestIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.shopId,
        identity.catalogVersion,
        identity.planKey,
        identity.lookupKey,
        identity.returnTarget,
      ])
    )
    .digest("hex")
}

// ---------- Reading ----------

const stateSchema = z.enum(COMMERCIAL_BILLING_STATES)
const snapshotSchema = z.object({
  shop_id: z.string().uuid(),
  account: z
    .object({
      state: stateSchema,
      state_reason: z.string().nullable(),
      catalog_version: z.string(),
      plan_key: z.string(),
      provider_mode: z.string(),
      has_platform_customer: z.boolean(),
      version: z.number().int(),
    })
    .nullable(),
  attempt: z
    .object({
      id: z.string().uuid(),
      attempt_no: z.number().int(),
      status: z.enum(["started", "session_open", "completed_unverified", "expired", "rejected", "unknown"]),
      failure_code: z.string().nullable(),
      session_id: z.string().nullable(),
    })
    .nullable()
    .optional(),
  evidence: z
    .object({
      id: z.string().uuid(),
      derived_state: z.string(),
      provider_status: z.string(),
      catalog_version: z.string(),
      plan_key: z.string(),
      price_lookup_key: z.string(),
      evidence_source: z.string(),
      livemode: z.boolean(),
    })
    .nullable()
    .optional(),
})

export type SnapshotRead =
  | { ok: true; snapshot: BillingSnapshot }
  | { ok: false; reason: "forbidden" | "failed" }

/** Reads the persisted state. A failed read is never reported as "no account". */
export async function readBillingSnapshot(client: SupabaseClient, shopId: string): Promise<SnapshotRead> {
  const { data, error } = await client.rpc("commercial_billing_read", { p_shop: shopId })
  if (error) return { ok: false, reason: error.code === "42501" ? "forbidden" : "failed" }
  const parsed = snapshotSchema.safeParse(data)
  if (!parsed.success || parsed.data.shop_id !== shopId) return { ok: false, reason: "failed" }
  const { account, attempt, evidence } = parsed.data
  return {
    ok: true,
    snapshot: {
      account: account && {
        state: account.state,
        stateReason: account.state_reason,
        catalogVersion: account.catalog_version,
        planKey: account.plan_key,
        providerMode: account.provider_mode,
        hasPlatformCustomer: account.has_platform_customer,
        version: account.version,
      },
      attempt: attempt
        ? {
            id: attempt.id,
            attemptNo: attempt.attempt_no,
            status: attempt.status,
            failureCode: attempt.failure_code,
            sessionId: attempt.session_id,
          }
        : null,
      evidence: evidence
        ? {
            id: evidence.id,
            derivedState: evidence.derived_state,
            providerStatus: evidence.provider_status,
            catalogVersion: evidence.catalog_version,
            planKey: evidence.plan_key,
            priceLookupKey: evidence.price_lookup_key,
            evidenceSource: evidence.evidence_source,
            livemode: evidence.livemode,
          }
        : null,
    },
  }
}

/** DTO for the owner UI and for the activation gate. Never creates anything. */
export async function readCommercialBillingDto(
  client: SupabaseClient,
  runtime: BillingRuntime,
  shopId: string
): Promise<CommercialBillingDto> {
  if (!runtime.ok) return blockedDto("unconfigured", runtime.reason)
  const read = await readBillingSnapshot(client, shopId)
  if (!read.ok) {
    return read.reason === "forbidden"
      ? blockedDto("unknown", "owner_required")
      : blockedDto("unknown", "billing_state_unavailable")
  }
  return billingDto(evaluateBillingSnapshot(read.snapshot))
}

// ---------- Checkout request ----------

const beginSchema = z.object({
  action: z.enum(["create", "replay", "in_progress", "blocked", "active"]),
  state: stateSchema,
  reason: z.string().nullable().optional(),
  attempt_id: z.string().uuid().optional(),
  attempt_no: z.number().int().optional(),
  session_id: z.string().optional(),
  customer_id: z.string().nullable().optional(),
})
type Begin = z.infer<typeof beginSchema>

type RpcOutcome<T> = { ok: true; data: T } | { ok: false; kind: "forbidden" | "conflict" | "invalid" | "failed" }

async function callRpc<T>(
  service: SupabaseClient,
  name: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>
): Promise<RpcOutcome<T>> {
  const { data, error } = await service.rpc(name, params)
  if (error) {
    const kind =
      error.code === "42501" ? "forbidden" : error.code === "CB409" ? "conflict" : error.code === "22023" ? "invalid" : "failed"
    return { ok: false, kind }
  }
  const parsed = schema.safeParse(data)
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, kind: "failed" }
}

const anyObject = z.object({}).passthrough()

export type CheckoutRequest = {
  shopId: string
  /** The authenticated user. The database must find them a live owner of shopId. */
  actorId: string
  returnTarget?: CheckoutReturnTarget
}

const pendingDto = (reason: "checkout_required" | "checkout_in_progress" | "checkout_completed_awaiting_evidence" | "provider_unavailable", url: string | null = null) =>
  billingDto({ state: "checkout_pending", eligibleToActivate: false, blockingReason: reason }, url)

/**
 * Creates, or safely reuses, the single Founder Pilot Checkout for a workspace.
 * Never returns a Checkout URL unless the provider reports the bound session open.
 */
export async function requestFounderPilotCheckout(
  deps: { service: SupabaseClient; runtime: BillingRuntime },
  request: CheckoutRequest
): Promise<CommercialBillingDto> {
  const { service, runtime } = deps
  if (!runtime.ok) return blockedDto("unconfigured", runtime.reason)
  const target = request.returnTarget ?? "agents"
  if (!isReturnTarget(target)) return blockedDto("unknown", "billing_state_unavailable")
  const urls = buildCheckoutReturnUrls(runtime.returnOrigin, target)
  if (!urls.ok) return blockedDto("unconfigured", urls.reason)
  const { stripe } = runtime
  const { shopId, actorId } = request

  const fingerprint = checkoutRequestFingerprint({
    shopId,
    catalogVersion: COMMERCIAL_CATALOG_VERSION,
    planKey: COMMERCIAL_PLAN_KEY,
    lookupKey: FOUNDER_PILOT_PRICE.lookupKey,
    returnTarget: target,
  })

  const mark = async (name: "commercial_checkout_reject" | "commercial_checkout_mark_unknown", attemptId: string, code: string) =>
    callRpc(service, name, { p_shop: shopId, p_actor: actorId, p_attempt: attemptId, p_code: code }, anyObject)

  const snapshotDto = async (): Promise<CommercialBillingDto> => {
    const read = await readBillingSnapshot(service, shopId)
    return read.ok ? billingDto(evaluateBillingSnapshot(read.snapshot)) : blockedDto("unknown", "billing_state_unavailable")
  }

  // At most one expired session is replaced per call; never an unbounded loop.
  for (let pass = 0; pass < 2; pass += 1) {
    const begun = await callRpc(
      service,
      "commercial_checkout_begin",
      {
        p_shop: shopId,
        p_actor: actorId,
        p_catalog_version: COMMERCIAL_CATALOG_VERSION,
        p_plan_key: COMMERCIAL_PLAN_KEY,
        p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey,
        p_return_target: target,
        p_fingerprint: fingerprint,
      },
      beginSchema
    )
    if (!begun.ok) {
      if (begun.kind === "forbidden") return blockedDto("unknown", "owner_required")
      if (begun.kind === "conflict") return blockedDto("checkout_pending", "checkout_conflict")
      return blockedDto("unknown", "billing_state_unavailable")
    }
    const b: Begin = begun.data

    if (b.action === "active" || b.action === "blocked") return snapshotDto()
    if (b.action === "in_progress") return pendingDto("checkout_in_progress")

    if (b.action === "replay") {
      if (!b.attempt_id || !b.session_id || !b.customer_id) return blockedDto("unknown", "billing_state_unavailable")
      const observe = (observed: "open" | "complete" | "expired") =>
        callRpc(
          service,
          "commercial_checkout_observe",
          { p_shop: shopId, p_actor: actorId, p_attempt: b.attempt_id, p_observed: observed },
          anyObject
        )
      let retrieved
      try {
        retrieved = await stripe.retrieveCheckoutSession({
          sessionId: b.session_id,
          binding: { shopId, attemptId: b.attempt_id, customerId: b.customer_id },
        })
      } catch {
        // A failed READ changes nothing locally and creates nothing remotely.
        return pendingDto("provider_unavailable")
      }
      if (!retrieved.ok) {
        await mark("commercial_checkout_mark_unknown", b.attempt_id, "session_binding_mismatch")
        return snapshotDto()
      }
      const { session } = retrieved
      if (session.status === "open") {
        await observe("open")
        return session.url ? pendingDto("checkout_required", session.url) : pendingDto("provider_unavailable")
      }
      if (session.status === "complete") {
        // The redirect already happened, but that is not payment proof.
        await observe("complete")
        return pendingDto("checkout_completed_awaiting_evidence")
      }
      const expired = await observe("expired")
      if (!expired.ok) return pendingDto("provider_unavailable")
      continue // begin again: the expired attempt is closed, a new one is safe
    }

    // action === "create"
    if (!b.attempt_id) return blockedDto("unknown", "billing_state_unavailable")
    const attemptId = b.attempt_id

    // 1. Verify the approved Price (read-only; nothing exists remotely yet).
    let price
    try {
      price = await stripe.verifyFounderPilotPrice()
    } catch {
      await mark("commercial_checkout_reject", attemptId, "price_lookup_unavailable")
      return billingDto({ state: "checkout_required", eligibleToActivate: false, blockingReason: "provider_unavailable" })
    }
    if (!price.ok) {
      await mark("commercial_checkout_reject", attemptId, price.code)
      return billingDto({ state: "checkout_required", eligibleToActivate: false, blockingReason: "price_verification_failed" })
    }

    // 2. Bind or reuse the one PLATFORM customer for this shop.
    let customerId = b.customer_id ?? null
    if (!customerId) {
      try {
        const created = await stripe.createCustomer({ shopId, idempotencyKey: customerIdempotencyKey(shopId) })
        customerId = created.customerId
      } catch (error) {
        if (isDefinitiveRejection(error)) {
          await mark("commercial_checkout_reject", attemptId, "customer_rejected")
          return billingDto({ state: "checkout_required", eligibleToActivate: false, blockingReason: "provider_unavailable" })
        }
        await mark("commercial_checkout_mark_unknown", attemptId, "customer_outcome_unknown")
        return snapshotDto()
      }
      const bound = await callRpc(
        service,
        "commercial_checkout_bind_customer",
        { p_shop: shopId, p_actor: actorId, p_attempt: attemptId, p_customer: customerId },
        anyObject
      )
      if (!bound.ok) {
        // The customer may exist remotely but is not durably ours: do not guess.
        await mark(
          "commercial_checkout_mark_unknown",
          attemptId,
          bound.kind === "conflict" ? "customer_mismatch" : "customer_bind_failed"
        )
        return snapshotDto()
      }
    }

    // 3. Create the Checkout Session, bound to shop, catalog and this attempt.
    let session
    try {
      session = await stripe.createCheckoutSession({
        priceId: price.priceId,
        customerId,
        shopId,
        attemptId,
        successUrl: urls.successUrl,
        cancelUrl: urls.cancelUrl,
        idempotencyKey: sessionIdempotencyKey(attemptId),
      })
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        await mark("commercial_checkout_reject", attemptId, "session_rejected")
        return billingDto({ state: "checkout_required", eligibleToActivate: false, blockingReason: "provider_unavailable" })
      }
      // Timeout / 5xx / 409 / 429 / unreadable: the Session may exist. Never retry blindly.
      await mark("commercial_checkout_mark_unknown", attemptId, "session_outcome_unknown")
      return snapshotDto()
    }

    const recorded = await callRpc(
      service,
      "commercial_checkout_record_session",
      { p_shop: shopId, p_actor: actorId, p_attempt: attemptId, p_session: session.id },
      anyObject
    )
    if (!recorded.ok) {
      await mark("commercial_checkout_mark_unknown", attemptId, "session_record_failed")
      return snapshotDto()
    }
    return session.url ? pendingDto("checkout_required", session.url) : pendingDto("provider_unavailable")
  }

  // Two expired sessions in a row: stop rather than loop; the next request continues.
  return pendingDto("provider_unavailable")
}
