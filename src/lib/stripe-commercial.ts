import { z } from "zod"

import {
  COMMERCIAL_CATALOG_VERSION,
  COMMERCIAL_PLAN_KEY,
} from "@/lib/commercial-billing"
import {
  buildFounderPilotLineItems,
  evaluateSubscriptionItems,
  type CheckoutLineItem,
} from "@/lib/commercial-subscription-items"
import { COMMERCIAL_METER_API_VERSION, evaluateSandboxReadiness } from "@/lib/stripe-sandbox-contract"
import { collectSandboxSnapshot } from "@/lib/stripe-sandbox-snapshot"
import {
  StripeError,
  stripeCommercialRequest,
  type CommercialStripeTransportConfig,
} from "@/lib/stripe"

/**
 * Sandbox-only Stripe PLATFORM client for the Founder Pilot subscription.
 *
 *  - Disabled unless explicitly configured for test mode; a live, ambiguous or
 *    mismatched configuration is refused before any request is built.
 *  - Platform billing only: there is no connected-account parameter anywhere.
 *  - Every response is validated; a live-mode object is refused.
 *  - Transport failures are AMBIGUOUS (StripeError status 0 / 5xx / 409 / 429),
 *    only a 4xx rejection is DEFINITIVE. Callers must treat them differently.
 *  - Secrets, Checkout URLs and raw payloads are never logged or placed in errors.
 */

export const COMMERCIAL_STRIPE_TIMEOUT_MS = 15_000
const DEFAULT_API_BASE = "https://api.stripe.com/v1"

export type CommercialStripeConfigResult =
  | { ok: true; config: CommercialStripeTransportConfig; returnOrigin: string | null }
  | { ok: false; reason: "billing_unconfigured" | "billing_misconfigured" }

/**
 * Reads the sandbox configuration. Requires, all at once:
 *   GRADIA_COMMERCIAL_BILLING_STRIPE_MODE = "test"
 *   STRIPE_SECRET_KEY                     = sk_test_… / rk_test_…
 *   STRIPE_API_BASE                       = unset, or a loopback fixture
 * Anything missing is `billing_unconfigured`; anything present but wrong or
 * live-shaped is `billing_misconfigured`. Neither throws and neither leaks a value.
 */
export function resolveCommercialStripeConfig(
  env: Record<string, string | undefined> = process.env
): CommercialStripeConfigResult {
  const mode = env.GRADIA_COMMERCIAL_BILLING_STRIPE_MODE?.trim()
  const key = env.STRIPE_SECRET_KEY?.trim()
  if (!mode || !key) return { ok: false, reason: "billing_unconfigured" }
  if (mode !== "test") return { ok: false, reason: "billing_misconfigured" }
  // A live key is refused even if the mode flag says "test". Only test keys pass.
  if (!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key)) return { ok: false, reason: "billing_misconfigured" }

  const rawBase = env.STRIPE_API_BASE?.trim()
  let apiBase = DEFAULT_API_BASE
  if (rawBase) {
    let parsed: URL
    try {
      parsed = new URL(rawBase)
    } catch {
      return { ok: false, reason: "billing_misconfigured" }
    }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]"
    const official = parsed.origin === "https://api.stripe.com"
    // The key must never be sent to an arbitrary host.
    if ((!loopback && !official) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { ok: false, reason: "billing_misconfigured" }
    }
    apiBase = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
  }
  const dashboard = env.GRADIA_DASHBOARD_URL?.trim() || null
  return {
    ok: true,
    config: { secretKey: key, apiBase, timeoutMs: COMMERCIAL_STRIPE_TIMEOUT_MS },
    returnOrigin: dashboard,
  }
}

// ---------- Result classification ----------

/**
 * A 4xx rejection means the provider did not act (nothing exists remotely), so
 * a later attempt is safe. Everything else — timeout, transport error,
 * unreadable reply, 409/429/5xx — may or may not have acted: AMBIGUOUS.
 */
export function isDefinitiveRejection(error: unknown): boolean {
  return (
    error instanceof StripeError &&
    [400, 401, 402, 403, 404].includes(error.status)
  )
}

// ---------- Validated provider objects ----------

/**
 * Why the exact Founder Pilot item set could not be resolved. Every code is a finite, secret-free
 * contract finding (`evaluateSandboxReadiness`); nothing exists remotely when this is returned.
 */
export type ItemSetResolution =
  | { ok: true; lineItems: CheckoutLineItem[] }
  | { ok: false; code: string }

const customerSchema = z.object({
  id: z.string().regex(/^cus_[A-Za-z0-9_]{4,120}$/),
  object: z.literal("customer"),
  livemode: z.boolean(),
})

const checkoutSessionSchema = z.object({
  id: z.string().regex(/^cs_test_[A-Za-z0-9_]{4,200}$/),
  object: z.literal("checkout.session"),
  livemode: z.boolean(),
  mode: z.string(),
  // Missing, null or unknown status is unreadable: it must never be assumed "open".
  status: z.enum(["open", "complete", "expired"]),
  url: z.string().nullable(),
  customer: z.string().nullable(),
  client_reference_id: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
  // Expanded only on retrieval. Absent or unreadable is never "exact".
  line_items: z.object({ data: z.array(z.unknown()) }).nullable().optional(),
})

export type CheckoutBinding = {
  shopId: string
  attemptId: string
  customerId: string
}

export type PlatformCheckoutSession = {
  id: string
  status: "open" | "complete" | "expired"
  /** Present only while the session is open. Never logged, never stored. */
  url: string | null
}

export type PlatformStripeClient = {
  /**
   * Resolves the EXACT Founder Pilot item set (licensed base + six metered Prices) by lookup key and verifies
   * every Price, the Product and every Meter against the reviewed contract. Read-only. A missing, duplicate,
   * live, inactive or mismatched object refuses; nothing is created or repaired.
   */
  resolveFounderPilotItemSet(): Promise<ItemSetResolution>
  /** Creates (or idempotently replays) the one platform Customer for a shop. */
  createCustomer(input: { shopId: string; idempotencyKey: string }): Promise<{ customerId: string }>
  /** Creates (or idempotently replays) the Checkout Session for one attempt. */
  createCheckoutSession(input: {
    /** From `resolveFounderPilotItemSet`: base x1 first, then six metered items with no quantity. */
    lineItems: CheckoutLineItem[]
    customerId: string
    shopId: string
    attemptId: string
    successUrl: string
    cancelUrl: string
    idempotencyKey: string
  }): Promise<PlatformCheckoutSession>
  /** Reads a session and verifies it is bound to this shop and attempt. */
  retrieveCheckoutSession(input: {
    sessionId: string
    binding: CheckoutBinding
  }): Promise<{ ok: true; session: PlatformCheckoutSession } | { ok: false; code: "session_binding_mismatch" }>
}

function safeCheckoutUrl(url: string | null, status: string | null): string | null {
  if (status !== "open" || !url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.hostname !== "checkout.stripe.com") return null
    return url
  } catch {
    return null
  }
}

/** Stripe form keys for the line items. Metered items carry NO quantity (Stripe: it must not be defined). */
function lineItemParams(lineItems: CheckoutLineItem[]): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  lineItems.forEach((item, index) => {
    params[`line_items[${index}][price]`] = item.priceId
    if (item.quantity !== undefined) params[`line_items[${index}][quantity]`] = item.quantity
  })
  return params
}

function unreadable(): StripeError {
  return new StripeError(0, "Stripe returned an unexpected response", "unreadable_response")
}

/** Builds the real client over the shared Stripe adapter. Network-free until called. */
export function createPlatformStripeClient(
  config: CommercialStripeTransportConfig,
  /** Injectable transport (the opt-in test-clock harness passes an allowlisted, live-refusing one). */
  request: typeof stripeCommercialRequest = stripeCommercialRequest
): PlatformStripeClient {
  // Tenant / catalog / attempt binding, written under `prefix` (Stripe nests form keys).
  const metadataFor = (shopId: string, attemptId?: string, prefix = "metadata") => {
    const base: Record<string, string> = {
      [`${prefix}[shop_id]`]: shopId,
      [`${prefix}[catalog_version]`]: COMMERCIAL_CATALOG_VERSION,
      [`${prefix}[plan_key]`]: COMMERCIAL_PLAN_KEY,
    }
    if (attemptId) base[`${prefix}[checkout_attempt_id]`] = attemptId
    return base
  }
  return {
    async resolveFounderPilotItemSet() {
      const snapshot = await collectSandboxSnapshot(config, request)
      // Unreachable provider: an ambiguous READ, never "not ready". The caller handles it as unavailable.
      if ("failure" in snapshot) throw new StripeError(0, "Stripe sandbox could not be read", "provider_unreachable")
      const readiness = evaluateSandboxReadiness(snapshot)
      if (!readiness.ready || !readiness.verifiedPrices) {
        return { ok: false, code: `item_set_${readiness.findings[0]?.code ?? "not_ready"}`.slice(0, 63) }
      }
      const lineItems = buildFounderPilotLineItems(readiness.verifiedPrices)
      return lineItems ? { ok: true, lineItems } : { ok: false, code: "item_set_not_ready" }
    },

    async createCustomer({ shopId, idempotencyKey }) {
      const payload = await request<unknown>(config, {
        method: "POST",
        path: "/customers",
        body: metadataFor(shopId),
        idempotencyKey,
      })
      const parsed = customerSchema.safeParse(payload)
      if (!parsed.success) throw unreadable()
      if (parsed.data.livemode !== false) {
        throw new StripeError(0, "Live-mode object refused", "live_object_refused")
      }
      return { customerId: parsed.data.id }
    },

    async createCheckoutSession(input) {
      const meta = metadataFor(input.shopId, input.attemptId)
      const subscriptionMeta = metadataFor(input.shopId, input.attemptId, "subscription_data[metadata]")
      const payload = await request<unknown>(config, {
        method: "POST",
        path: "/checkout/sessions",
        idempotencyKey: input.idempotencyKey,
        apiVersion: COMMERCIAL_METER_API_VERSION,
        body: {
          mode: "subscription",
          customer: input.customerId,
          ...lineItemParams(input.lineItems),
          client_reference_id: input.attemptId,
          payment_method_collection: "always",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          ...meta,
          ...subscriptionMeta,
        },
      })
      const parsed = checkoutSessionSchema.safeParse(payload)
      if (!parsed.success || parsed.data.mode !== "subscription") throw unreadable()
      if (parsed.data.livemode !== false) {
        throw new StripeError(0, "Live-mode object refused", "live_object_refused")
      }
      return {
        id: parsed.data.id,
        status: parsed.data.status,
        url: safeCheckoutUrl(parsed.data.url, parsed.data.status),
      }
    },

    async retrieveCheckoutSession({ sessionId, binding }) {
      const payload = await request<unknown>(config, {
        method: "GET",
        path: `/checkout/sessions/${encodeURIComponent(sessionId)}`,
        apiVersion: COMMERCIAL_METER_API_VERSION,
        body: { "expand[0]": "line_items" },
      })
      const parsed = checkoutSessionSchema.safeParse(payload)
      if (!parsed.success) throw unreadable()
      const s = parsed.data
      if (s.livemode !== false) throw new StripeError(0, "Live-mode object refused", "live_object_refused")
      if (s.id !== sessionId) return { ok: false, code: "session_binding_mismatch" }
      const m = s.metadata ?? {}
      const bound =
        s.mode === "subscription" &&
        s.client_reference_id === binding.attemptId &&
        m.shop_id === binding.shopId &&
        m.checkout_attempt_id === binding.attemptId &&
        m.catalog_version === COMMERCIAL_CATALOG_VERSION &&
        m.plan_key === COMMERCIAL_PLAN_KEY &&
        s.customer === binding.customerId &&
        // The exact item set, in any order. Metadata above is only a cross-check of the server-held binding.
        evaluateSubscriptionItems(s.line_items?.data).ok
      if (!bound) return { ok: false, code: "session_binding_mismatch" }
      return { ok: true, session: { id: s.id, status: s.status, url: safeCheckoutUrl(s.url, s.status) } }
    },
  }
}

// ---------- Customer Portal (owner-only handoff, PR E1) ----------

const portalSessionSchema = z.object({
  id: z.string().regex(/^bps_[A-Za-z0-9_]{4,200}$/),
  object: z.literal("billing_portal.session"),
  livemode: z.boolean(),
  customer: z.string(),
  url: z.string(),
})

/** The portal URL is a short-lived bearer link: https on billing.stripe.com only. */
function safePortalUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.hostname !== "billing.stripe.com" || parsed.username || parsed.password) return null
    return url
  } catch {
    return null
  }
}

export type PlatformPortalClient = {
  /**
   * Creates one Customer Portal session for the EXACT bound platform customer. Test mode only,
   * PLATFORM account only (no connected-account parameter). The returned URL is never stored
   * or logged by callers. An unreadable, live-mode, mismatched or off-host reply throws an
   * ambiguous StripeError and yields no URL.
   */
  createBillingPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>
}

export function createPlatformPortalClient(config: CommercialStripeTransportConfig): PlatformPortalClient {
  return {
    async createBillingPortalSession({ customerId, returnUrl }) {
      const payload = await stripeCommercialRequest<unknown>(config, {
        method: "POST",
        path: "/billing_portal/sessions",
        body: { customer: customerId, return_url: returnUrl },
      })
      const parsed = portalSessionSchema.safeParse(payload)
      if (!parsed.success) throw unreadable()
      if (parsed.data.livemode !== false) throw new StripeError(0, "Live-mode object refused", "live_object_refused")
      if (parsed.data.customer !== customerId) throw unreadable()
      const url = safePortalUrl(parsed.data.url)
      if (!url) throw unreadable()
      return { url }
    },
  }
}
