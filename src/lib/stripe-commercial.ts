import { z } from "zod"

import {
  COMMERCIAL_CATALOG_VERSION,
  COMMERCIAL_PLAN_KEY,
  FOUNDER_PILOT_PRICE,
} from "@/lib/commercial-billing"
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

const priceSchema = z.object({
  id: z.string().regex(/^price_[A-Za-z0-9_]+$/),
  object: z.literal("price"),
  active: z.boolean(),
  currency: z.string(),
  lookup_key: z.string().nullable(),
  type: z.string(),
  unit_amount: z.number().int().nullable(),
  billing_scheme: z.string(),
  livemode: z.boolean(),
  recurring: z
    .object({
      interval: z.string(),
      interval_count: z.number().int(),
      usage_type: z.string(),
    })
    .nullable(),
})
const priceListSchema = z.object({ data: z.array(z.unknown()).max(10) })

export type PriceVerification =
  | { ok: true; priceId: string }
  | {
      ok: false
      code:
        | "price_missing"
        | "price_ambiguous"
        | "price_invalid_response"
        | "price_live_object"
        | "price_lookup_mismatch"
        | "price_inactive"
        | "price_currency_mismatch"
        | "price_amount_mismatch"
        | "price_interval_mismatch"
        | "price_usage_mismatch"
    }

/** Verifies a provider Price against the approved Founder Pilot contract. */
export function verifyFounderPilotPrice(listPayload: unknown): PriceVerification {
  const list = priceListSchema.safeParse(listPayload)
  if (!list.success) return { ok: false, code: "price_invalid_response" }
  if (list.data.data.length === 0) return { ok: false, code: "price_missing" }
  if (list.data.data.length > 1) return { ok: false, code: "price_ambiguous" }
  const parsed = priceSchema.safeParse(list.data.data[0])
  if (!parsed.success) return { ok: false, code: "price_invalid_response" }
  const price = parsed.data
  if (price.livemode !== false) return { ok: false, code: "price_live_object" }
  if (price.lookup_key !== FOUNDER_PILOT_PRICE.lookupKey) return { ok: false, code: "price_lookup_mismatch" }
  if (!price.active) return { ok: false, code: "price_inactive" }
  if (price.currency !== FOUNDER_PILOT_PRICE.currency) return { ok: false, code: "price_currency_mismatch" }
  if (price.type !== "recurring" || price.billing_scheme !== "per_unit" || price.unit_amount !== FOUNDER_PILOT_PRICE.unitAmountCents) {
    return { ok: false, code: "price_amount_mismatch" }
  }
  if (!price.recurring || price.recurring.interval !== FOUNDER_PILOT_PRICE.interval || price.recurring.interval_count !== 1) {
    return { ok: false, code: "price_interval_mismatch" }
  }
  if (price.recurring.usage_type !== "licensed") return { ok: false, code: "price_usage_mismatch" }
  return { ok: true, priceId: price.id }
}

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
  status: z.enum(["open", "complete", "expired"]).nullable(),
  url: z.string().nullable(),
  customer: z.string().nullable(),
  client_reference_id: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
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
  /** Resolves and verifies the approved Price by lookup key. Read-only. */
  verifyFounderPilotPrice(): Promise<PriceVerification>
  /** Creates (or idempotently replays) the one platform Customer for a shop. */
  createCustomer(input: { shopId: string; idempotencyKey: string }): Promise<{ customerId: string }>
  /** Creates (or idempotently replays) the Checkout Session for one attempt. */
  createCheckoutSession(input: {
    priceId: string
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

function unreadable(): StripeError {
  return new StripeError(0, "Stripe returned an unexpected response", "unreadable_response")
}

/** Builds the real client over the shared Stripe adapter. Network-free until called. */
export function createPlatformStripeClient(config: CommercialStripeTransportConfig): PlatformStripeClient {
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
    async verifyFounderPilotPrice() {
      const payload = await stripeCommercialRequest<unknown>(config, {
        method: "GET",
        path: "/prices",
        body: { "lookup_keys[0]": FOUNDER_PILOT_PRICE.lookupKey, limit: 3 },
      })
      return verifyFounderPilotPrice(payload)
    },

    async createCustomer({ shopId, idempotencyKey }) {
      const payload = await stripeCommercialRequest<unknown>(config, {
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
      const payload = await stripeCommercialRequest<unknown>(config, {
        method: "POST",
        path: "/checkout/sessions",
        idempotencyKey: input.idempotencyKey,
        body: {
          mode: "subscription",
          customer: input.customerId,
          "line_items[0][price]": input.priceId,
          "line_items[0][quantity]": 1,
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
        status: parsed.data.status ?? "open",
        url: safeCheckoutUrl(parsed.data.url, parsed.data.status ?? "open"),
      }
    },

    async retrieveCheckoutSession({ sessionId, binding }) {
      const payload = await stripeCommercialRequest<unknown>(config, {
        method: "GET",
        path: `/checkout/sessions/${encodeURIComponent(sessionId)}`,
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
        s.customer === binding.customerId
      if (!bound || !s.status) return { ok: false, code: "session_binding_mismatch" }
      return { ok: true, session: { id: s.id, status: s.status, url: safeCheckoutUrl(s.url, s.status) } }
    },
  }
}
