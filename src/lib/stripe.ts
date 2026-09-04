/**
 * Stripe API wrapper (server-only).
 *
 * Connect model: shops own Standard accounts; we charge on their
 * behalf with the `Stripe-Account` header. We store only the
 * `acct_XXX` connected-account id — never a per-shop secret key.
 *
 * Charge flow uses Stripe Invoices instead of direct card charges:
 * the customer gets a hosted-payment email and pays from their phone.
 * No card-on-file UX needed for the pilot.
 *
 * Docs: https://stripe.com/docs/api
 */

import { createHmac, timingSafeEqual } from "node:crypto"

import { PLAN, TIER_ORDER } from "@/lib/pricing"
import type { ShopTier } from "@/lib/types/database"

// Env-overridable so tests can point the executor at a mock server.
const STRIPE_API_BASE =
  process.env.STRIPE_API_BASE?.trim() || "https://api.stripe.com/v1"
const STRIPE_API_VERSION = "2024-06-20"

const WEBHOOK_TOLERANCE_SECONDS = 300

export class StripeError extends Error {
  status: number
  code: string | null
  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.name = "StripeError"
  }
}

function platformKey(): string {
  const k = process.env.STRIPE_SECRET_KEY?.trim()
  if (!k) {
    throw new StripeError(500, "STRIPE_SECRET_KEY is not configured")
  }
  return k
}

function connectClientId(): string {
  const k = process.env.STRIPE_CONNECT_CLIENT_ID?.trim()
  if (!k) {
    throw new StripeError(500, "STRIPE_CONNECT_CLIENT_ID is not configured")
  }
  return k
}

/**
 * URL-encodes a flat dict of params. Stripe accepts only
 * application/x-www-form-urlencoded bodies (no JSON) — keeps the
 * Authorization signature simple too.
 */
function encodeForm(params: Record<string, string | number | boolean | undefined | null>): string {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    form.set(k, String(v))
  }
  return form.toString()
}

type StripeFetchOptions = {
  method: "GET" | "POST" | "DELETE"
  path: string
  body?: Record<string, string | number | boolean | undefined | null>
  /** When set, acts on the connected account (Stripe-Account header). */
  stripeAccount?: string | null
}

async function stripeFetch<T>(opts: StripeFetchOptions): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${platformKey()}`,
    "Stripe-Version": STRIPE_API_VERSION,
  }
  if (opts.stripeAccount) {
    headers["Stripe-Account"] = opts.stripeAccount
  }

  let url = `${STRIPE_API_BASE}${opts.path}`
  let body: string | undefined
  if (opts.method === "GET" && opts.body) {
    const qs = encodeForm(opts.body)
    if (qs) url += `?${qs}`
  } else if (opts.body) {
    body = encodeForm(opts.body)
    headers["Content-Type"] = "application/x-www-form-urlencoded"
  }

  const res = await fetch(url, { method: opts.method, headers, body })
  const text = await res.text()

  if (!res.ok) {
    let code: string | null = null
    let message = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; message?: string }
      }
      code = parsed.error?.code ?? null
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      // body wasn't JSON
    }
    throw new StripeError(res.status, message, code)
  }

  return JSON.parse(text) as T
}

// ---------- Connect onboarding ----------

export type StripeConnectedAccount = {
  id: string
  charges_enabled: boolean
  details_submitted: boolean
  email: string | null
}

export async function createConnectedAccount(input: {
  email?: string | null
  country?: string
}): Promise<StripeConnectedAccount> {
  return stripeFetch<StripeConnectedAccount>({
    method: "POST",
    path: "/accounts",
    body: {
      type: "standard",
      country: input.country ?? "US",
      email: input.email ?? null,
    },
  })
}

export async function getConnectedAccount(
  accountId: string
): Promise<StripeConnectedAccount> {
  return stripeFetch<StripeConnectedAccount>({
    method: "GET",
    path: `/accounts/${encodeURIComponent(accountId)}`,
  })
}

export type StripeAccountLink = {
  url: string
  expires_at: number
}

export async function createAccountOnboardingLink(input: {
  accountId: string
  refreshUrl: string
  returnUrl: string
}): Promise<StripeAccountLink> {
  // Confirm the Connect client ID is configured at link-creation time
  // so we fail fast with a clear error instead of an opaque Stripe one.
  connectClientId()
  return stripeFetch<StripeAccountLink>({
    method: "POST",
    path: "/account_links",
    body: {
      account: input.accountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: "account_onboarding",
    },
  })
}

// ---------- Embedded Connect (Account Sessions) ----------

export type StripeAccountSession = {
  /** Short-lived secret consumed by @stripe/connect-js on the client. */
  client_secret: string
  /** Unix seconds; sessions are ~60 min and refresh automatically. */
  expires_at: number
}

/**
 * Mints an Account Session scoped to a single connected account, with
 * the embedded onboarding component enabled. This is the modern (2024+)
 * replacement for Stripe-hosted Account Links: the entire KYC + bank
 * + identity flow renders inside our own UI via
 * `<ConnectAccountOnboarding />`, so the operator never leaves Gradia.
 *
 * Docs: https://stripe.com/docs/connect/get-started-connect-embedded-components
 */
export async function createAccountSession(input: {
  accountId: string
  /** Set true to also enable Payments/Payouts dashboards later. */
  enablePayments?: boolean
  enablePayouts?: boolean
}): Promise<StripeAccountSession> {
  const body: Record<string, string | number | boolean> = {
    account: input.accountId,
    "components[account_onboarding][enabled]": true,
    // Sensible default: account-management lets the operator update
    // bank/identity later from inside Gradia without a re-onboard.
    "components[account_management][enabled]": true,
  }
  if (input.enablePayments) {
    body["components[payments][enabled]"] = true
  }
  if (input.enablePayouts) {
    body["components[payouts][enabled]"] = true
  }
  return stripeFetch<StripeAccountSession>({
    method: "POST",
    path: "/account_sessions",
    body,
  })
}

// ---------- Listing paid invoices (backfill) ----------

export type StripePaidInvoice = {
  id: string
  number: string | null
  hosted_invoice_url: string | null
  currency: string | null
  description: string | null
  amount_paid: number
  customer: string | null
  status_transitions: { paid_at: number | null } | null
  lines: { data?: Array<{ description?: string | null }> } | null
}

type StripeListPage<T> = {
  data: T[]
  has_more: boolean
}

/**
 * Iterates every paid invoice on the connected account, page by page.
 * Stripe caps page size at 100; we follow has_more / starting_after
 * until exhausted. Backfill callers typically have at most a few
 * hundred historical invoices.
 */
export async function* iteratePaidInvoices(
  stripeAccount: string
): AsyncGenerator<StripePaidInvoice, void, void> {
  let startingAfter: string | undefined
  for (;;) {
    const body: Record<string, string | number | boolean | undefined> = {
      status: "paid",
      limit: 100,
    }
    if (startingAfter) body.starting_after = startingAfter

    const page = await stripeFetch<StripeListPage<StripePaidInvoice>>({
      method: "GET",
      path: "/invoices",
      body,
      stripeAccount,
    })

    for (const inv of page.data) {
      yield inv
    }
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }
}

// ---------- Subscription (platform-side: the Gradia plan) ----------

/**
 * One recurring Stripe Price per tier (P0-013 — D-031/D-034). The env vars
 * are the rollout switch: absent = every checkout path fails closed BEFORE
 * any Stripe call (the P0-010 acceptance property, kept under the new
 * names); present = live. Legacy `STRIPE_PRICE_ID` / `STRIPE_PRICE_VOICE_ADDON`
 * are retired and never read.
 */
export const TIER_PRICE_ENV: Record<ShopTier, string> = {
  core: "STRIPE_PRICE_CORE",
  pro: "STRIPE_PRICE_PRO",
  operator: "STRIPE_PRICE_OPERATOR",
}

/** The Price id for a tier — throws (500) before any network call when the
 *  env var is absent. */
export function tierPriceId(tier: ShopTier): string {
  const envName = TIER_PRICE_ENV[tier]
  const p = process.env[envName]?.trim()
  if (!p) {
    throw new StripeError(500, `${envName} is not configured`)
  }
  return p
}

/**
 * Reverse map for the webhook: which tier a Stripe Price id sells. `null`
 * for anything not configured — the caller must treat that as "unknown
 * price id → log + no-op", never guess a tier.
 */
export function tierFromPriceId(priceId: string | null | undefined): ShopTier | null {
  if (!priceId) return null
  for (const tier of TIER_ORDER) {
    const configured = process.env[TIER_PRICE_ENV[tier]]?.trim()
    if (configured && configured === priceId) return tier
  }
  return null
}

export type StripeCheckoutSession = {
  id: string
  url: string | null
}

function packPriceId(pack: "credit" | "minute"): string {
  const p =
    pack === "credit"
      ? process.env.STRIPE_PRICE_CREDIT_PACK?.trim()
      : process.env.STRIPE_PRICE_MINUTE_PACK?.trim()
  if (!p) {
    throw new StripeError(
      500,
      `STRIPE_PRICE_${pack === "credit" ? "CREDIT" : "MINUTE"}_PACK is not configured`
    )
  }
  return p
}

/**
 * Creates a Checkout Session for a Gradia tier on the PLATFORM account (no
 * Stripe-Account header) — distinct from the Connect flow that charges the
 * detailer's own customers. One line item = the tier's Price. shop_id rides
 * along as client_reference_id + metadata so the webhook can resolve the
 * shop; the tier is NOT trusted from metadata — the webhook re-derives it
 * from the subscription's Price id (Stripe truth).
 *
 * D-035 interim: a 14-day Stripe trial with the card collected up front
 * (`payment_method_collection` defaults to `always` for subscription mode).
 */
export async function createSubscriptionCheckoutSession(input: {
  shopId: string
  tier: ShopTier
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
}): Promise<StripeCheckoutSession> {
  const price = tierPriceId(input.tier) // fail closed before any call
  return stripeFetch<StripeCheckoutSession>({
    method: "POST",
    path: "/checkout/sessions",
    body: {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": 1,
      client_reference_id: input.shopId,
      "metadata[shop_id]": input.shopId,
      "metadata[tier]": input.tier,
      "subscription_data[metadata][shop_id]": input.shopId,
      "subscription_data[metadata][tier]": input.tier,
      "subscription_data[trial_period_days]": PLAN.TRIAL.days,
      customer_email: input.customerEmail ?? undefined,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
  })
}

/**
 * One-time top-up packs ($10 credit pack / $10 minute pack — PLAN). mode=payment;
 * metadata carries shop_id + pack so the webhook can insert the
 * credit_grant idempotently (session id = stripe_ref).
 */
export async function createPackCheckoutSession(input: {
  shopId: string
  pack: "credit" | "minute"
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
}): Promise<StripeCheckoutSession> {
  return stripeFetch<StripeCheckoutSession>({
    method: "POST",
    path: "/checkout/sessions",
    body: {
      mode: "payment",
      "line_items[0][price]": packPriceId(input.pack),
      "line_items[0][quantity]": 1,
      client_reference_id: input.shopId,
      "metadata[shop_id]": input.shopId,
      "metadata[pack]": input.pack,
      customer_email: input.customerEmail ?? undefined,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
  })
}

type StripeSubscriptionRaw = {
  id?: string
  status?: string
  trial_end?: number | null
  items?: {
    data?: Array<{ id?: string; price?: { id?: string } }>
  }
}

export type StripeSubscriptionSummary = {
  id: string
  status: string | null
  /** Unix seconds, or null when not trialing. */
  trialEnd: number | null
  items: Array<{ itemId: string; priceId: string }>
}

/** Reads a subscription's status, trial end and line items (price ids) —
 *  the webhook derives the tier from these, never from metadata. */
export async function getSubscription(
  subscriptionId: string
): Promise<StripeSubscriptionSummary> {
  const sub = await stripeFetch<StripeSubscriptionRaw>({
    method: "GET",
    path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  })
  return {
    id: sub.id ?? subscriptionId,
    status: sub.status ?? null,
    trialEnd: typeof sub.trial_end === "number" ? sub.trial_end : null,
    items: (sub.items?.data ?? [])
      .filter((i): i is { id: string; price: { id: string } } =>
        Boolean(i.id && i.price?.id)
      )
      .map((i) => ({ itemId: i.id, priceId: i.price.id })),
  }
}

/**
 * Upgrade / downgrade: swap the subscription's single item to the new tier's
 * Price with prorations. Stripe answers with customer.subscription.updated,
 * which is where the shop's tier actually changes (last-truth-from-Stripe;
 * this call persists nothing locally). Fails closed before any call when the
 * target tier's Price is not configured.
 */
export async function changeSubscriptionTier(
  subscriptionId: string,
  tier: ShopTier
): Promise<void> {
  const price = tierPriceId(tier)
  const sub = await getSubscription(subscriptionId)
  const item = sub.items[0]
  if (!item) {
    throw new StripeError(500, "Subscription has no line item to change")
  }
  await stripeFetch<unknown>({
    method: "POST",
    path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    body: {
      "items[0][id]": item.itemId,
      "items[0][price]": price,
      "items[0][quantity]": 1,
      proration_behavior: "create_prorations",
      "metadata[tier]": tier,
    },
  })
}

// ---------- Webhook signature verification ----------

/**
 * Verifies the Stripe-Signature header per Stripe's spec:
 *   - Header is `t={unix_seconds},v1={hex_hmac_sha256}` (and possibly
 *     more v1=... entries — any one matching is sufficient).
 *   - Signed payload is `${timestamp}.${rawBody}`.
 *   - HMAC-SHA256 with the endpoint's signing secret (whsec_...).
 *   - Reject ages > 5 minutes (replay protection).
 *
 * Returns true on valid + fresh signature; false on anything that
 * doesn't match. Fails closed when the secret isn't configured so
 * misconfig surfaces as 401 rather than silent acceptance.
 */
export function verifyStripeSignature(input: {
  rawBody: string
  signature: string | null
}): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim()
  if (!secret) return false
  if (!input.signature) return false

  let timestamp: string | null = null
  const candidateSignatures: string[] = []
  for (const part of input.signature.split(",")) {
    const [k, v] = part.trim().split("=")
    if (!k || !v) continue
    if (k === "t") timestamp = v
    else if (k === "v1") candidateSignatures.push(v)
  }
  if (!timestamp || candidateSignatures.length === 0) return false

  const ts = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return false
  const ageSeconds = Math.abs(Date.now() / 1000 - ts)
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return false

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest("hex")
  const expectedBuf = Buffer.from(expected)

  for (const sig of candidateSignatures) {
    const sigBuf = Buffer.from(sig)
    if (sigBuf.length !== expectedBuf.length) continue
    try {
      if (timingSafeEqual(expectedBuf, sigBuf)) return true
    } catch {
      // length mismatch already filtered; ignore
    }
  }
  return false
}
