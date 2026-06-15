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

function subscriptionPriceId(): string {
  const p = process.env.STRIPE_PRICE_ID?.trim()
  if (!p) {
    throw new StripeError(500, "STRIPE_PRICE_ID is not configured")
  }
  return p
}

export type StripeCheckoutSession = {
  id: string
  url: string | null
}

/** Voice Receptionist add-on price (+$29/mo, second item on the same
 *  subscription). Null when not configured — voice purchase paths
 *  surface a clear error instead of a broken checkout. */
export function voiceAddonPriceId(): string | null {
  return process.env.STRIPE_PRICE_VOICE_ADDON?.trim() || null
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
 * Creates a Checkout Session for the Gradia subscription on the PLATFORM
 * account (no Stripe-Account header) — distinct from the Connect flow that
 * charges the detailer's own customers. Core $20/mo always; the Voice
 * Receptionist add-on rides as a SECOND line item on the same subscription
 * when requested (GRADIA_PRICING.md SKU model). shop_id rides along as
 * client_reference_id + metadata so the webhook can mark the shop active.
 */
export async function createSubscriptionCheckoutSession(input: {
  shopId: string
  customerEmail?: string | null
  successUrl: string
  cancelUrl: string
  includeVoiceAddon?: boolean
}): Promise<StripeCheckoutSession> {
  const body: Record<string, string | number | undefined> = {
    mode: "subscription",
    "line_items[0][price]": subscriptionPriceId(),
    "line_items[0][quantity]": 1,
    client_reference_id: input.shopId,
    "metadata[shop_id]": input.shopId,
    "subscription_data[metadata][shop_id]": input.shopId,
    customer_email: input.customerEmail ?? undefined,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  }
  if (input.includeVoiceAddon) {
    const voicePrice = voiceAddonPriceId()
    if (!voicePrice) {
      throw new StripeError(500, "STRIPE_PRICE_VOICE_ADDON is not configured")
    }
    body["line_items[1][price]"] = voicePrice
    body["line_items[1][quantity]"] = 1
  }
  return stripeFetch<StripeCheckoutSession>({
    method: "POST",
    path: "/checkout/sessions",
    body,
  })
}

/**
 * One-time top-up packs ($10 credit pack / $10 minute pack). mode=payment;
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

type StripeSubscriptionItems = {
  items?: {
    data?: Array<{ id?: string; price?: { id?: string } }>
  }
}

/** Reads a subscription's line items (price ids) — used to detect the
 *  voice add-on and to find the item id for removal. */
export async function getSubscriptionItems(
  subscriptionId: string
): Promise<Array<{ itemId: string; priceId: string }>> {
  const sub = await stripeFetch<StripeSubscriptionItems>({
    method: "GET",
    path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  })
  return (sub.items?.data ?? [])
    .filter((i): i is { id: string; price: { id: string } } =>
      Boolean(i.id && i.price?.id)
    )
    .map((i) => ({ itemId: i.id, priceId: i.price.id }))
}

/** Adds the voice add-on as a second item on an existing subscription. */
export async function addVoiceAddonItem(subscriptionId: string): Promise<void> {
  const voicePrice = voiceAddonPriceId()
  if (!voicePrice) {
    throw new StripeError(500, "STRIPE_PRICE_VOICE_ADDON is not configured")
  }
  await stripeFetch<unknown>({
    method: "POST",
    path: "/subscription_items",
    body: {
      subscription: subscriptionId,
      price: voicePrice,
      quantity: 1,
      proration_behavior: "create_prorations",
    },
  })
}

/** Removes the voice add-on item (the receptionist disables next-call;
 *  the number stays reserved 30 days — handled app-side). */
export async function removeVoiceAddonItem(
  subscriptionId: string
): Promise<void> {
  const voicePrice = voiceAddonPriceId()
  if (!voicePrice) return
  const items = await getSubscriptionItems(subscriptionId)
  const voiceItem = items.find((i) => i.priceId === voicePrice)
  if (!voiceItem) return
  await stripeFetch<unknown>({
    method: "DELETE",
    path: `/subscription_items/${encodeURIComponent(voiceItem.itemId)}`,
    body: { proration_behavior: "create_prorations" },
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
