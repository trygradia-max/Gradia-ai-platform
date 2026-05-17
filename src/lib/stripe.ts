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

const STRIPE_API_BASE = "https://api.stripe.com/v1"
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

// ---------- Customers (on the connected account) ----------

type StripeListResponse<T> = { data: T[]; has_more: boolean }

export type StripeCustomer = {
  id: string
  email: string | null
  name: string | null
}

export async function findOrCreateStripeCustomer(input: {
  stripeAccount: string
  email: string
  name: string | null
}): Promise<StripeCustomer> {
  const list = await stripeFetch<StripeListResponse<StripeCustomer>>({
    method: "GET",
    path: "/customers",
    body: { email: input.email, limit: 1 },
    stripeAccount: input.stripeAccount,
  })
  if (list.data.length > 0) return list.data[0]

  return stripeFetch<StripeCustomer>({
    method: "POST",
    path: "/customers",
    body: { email: input.email, name: input.name ?? undefined },
    stripeAccount: input.stripeAccount,
  })
}

// ---------- Invoice charge ----------

export type StripeInvoice = {
  id: string
  status: string
  hosted_invoice_url: string | null
  number: string | null
  total: number
}

/**
 * One-shot "charge $X" via a sent invoice:
 *   1. Ensure a Stripe customer exists on the connected account.
 *   2. Stage an invoice item (the line we're charging for).
 *   3. Create an invoice that pulls in pending items, with
 *      collection_method=send_invoice so Stripe emails the customer.
 *   4. Send it — Stripe auto-finalizes and emails the hosted-payment URL.
 */
export async function chargeCustomerViaInvoice(input: {
  stripeAccount: string
  customerEmail: string
  customerName: string | null
  amountCents: number
  description: string
  daysUntilDue?: number
}): Promise<StripeInvoice> {
  if (input.amountCents <= 0) {
    throw new StripeError(400, "Charge amount must be greater than zero.")
  }

  const customer = await findOrCreateStripeCustomer({
    stripeAccount: input.stripeAccount,
    email: input.customerEmail,
    name: input.customerName,
  })

  await stripeFetch({
    method: "POST",
    path: "/invoiceitems",
    body: {
      customer: customer.id,
      amount: input.amountCents,
      currency: "usd",
      description: input.description,
    },
    stripeAccount: input.stripeAccount,
  })

  const invoice = await stripeFetch<StripeInvoice>({
    method: "POST",
    path: "/invoices",
    body: {
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: input.daysUntilDue ?? 7,
      pending_invoice_items_behavior: "include",
    },
    stripeAccount: input.stripeAccount,
  })

  // /send finalizes + emails. Returns the updated invoice with
  // hosted_invoice_url populated.
  return stripeFetch<StripeInvoice>({
    method: "POST",
    path: `/invoices/${encodeURIComponent(invoice.id)}/send`,
    stripeAccount: input.stripeAccount,
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
