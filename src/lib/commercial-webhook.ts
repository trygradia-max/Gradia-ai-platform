import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import { z } from "zod"

import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { evaluateSubscriptionItems } from "@/lib/commercial-subscription-items"

/**
 * Pure rules for the signed PLATFORM commercial webhook (Commercial Billing PR E1).
 * Sandbox/test mode only. No I/O besides hashing.
 *
 * Order of operations is a contract:
 *   configuration → RAW-body signature → parse → refuse Connect / live → normalize.
 * Nothing is parsed before the signature verifies, and nothing here ever selects a
 * tenant: the database resolves it from server-held bindings. This endpoint has its
 * own signing secret and is never the Stripe Connect webhook.
 */

export const COMMERCIAL_WEBHOOK_TOLERANCE_SECONDS = 300
export const COMMERCIAL_WEBHOOK_MAX_BODY_BYTES = 1_000_000

// ---------- Configuration ----------

export type CommercialWebhookConfig =
  | { ok: true; secret: string }
  | { ok: false; reason: "webhook_unconfigured" | "webhook_misconfigured" }

/**
 * Requires, all at once: mode flag `test`, a dedicated signing secret, and no
 * live-shaped Stripe key in the environment. The secret must differ from the
 * Connect webhook secret so the two endpoints can never be blurred. Absent →
 * unconfigured; present but wrong/live-shaped/shared → misconfigured. Never throws,
 * never echoes a value.
 */
export function resolveCommercialWebhookConfig(
  env: Record<string, string | undefined> = process.env
): CommercialWebhookConfig {
  const mode = env.GRADIA_COMMERCIAL_BILLING_STRIPE_MODE?.trim()
  const secret = env.GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET?.trim()
  if (!mode || !secret) return { ok: false, reason: "webhook_unconfigured" }
  if (mode !== "test") return { ok: false, reason: "webhook_misconfigured" }
  if (!/^whsec_[A-Za-z0-9]{16,}$/.test(secret)) return { ok: false, reason: "webhook_misconfigured" }
  const connectSecret = env.STRIPE_WEBHOOK_SECRET?.trim()
  if (connectSecret && connectSecret === secret) return { ok: false, reason: "webhook_misconfigured" }
  // A live-shaped key anywhere in the commercial configuration is refused outright.
  const key = env.STRIPE_SECRET_KEY?.trim()
  if (key && !/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key)) return { ok: false, reason: "webhook_misconfigured" }
  return { ok: true, secret }
}

// ---------- Signature ----------

export type SignatureResult = { ok: true } | { ok: false; code: "signature_missing" | "signature_malformed" | "signature_stale" | "signature_invalid" }

/**
 * Stripe's scheme: `t=<unix>,v1=<hex hmac-sha256 of "${t}.${rawBody}">`, any v1 may match,
 * fresh within the tolerance. The raw body is the EXACT bytes received (as text).
 */
export function verifyCommercialSignature(input: {
  rawBody: string
  header: string | null
  secret: string
  nowMs?: number
  toleranceSeconds?: number
}): SignatureResult {
  if (!input.header) return { ok: false, code: "signature_missing" }
  let timestamp: string | null = null
  const candidates: string[] = []
  for (const part of input.header.split(",")) {
    const index = part.indexOf("=")
    if (index < 1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key === "t") timestamp = value
    else if (key === "v1") candidates.push(value)
  }
  if (!timestamp || !/^[0-9]{1,12}$/.test(timestamp) || candidates.length === 0) {
    return { ok: false, code: "signature_malformed" }
  }
  const ageSeconds = Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp))
  if (ageSeconds > (input.toleranceSeconds ?? COMMERCIAL_WEBHOOK_TOLERANCE_SECONDS)) {
    return { ok: false, code: "signature_stale" }
  }
  const expected = createHmac("sha256", input.secret).update(`${timestamp}.${input.rawBody}`).digest()
  for (const candidate of candidates) {
    if (!/^[0-9a-f]{64}$/i.test(candidate)) continue
    const provided = Buffer.from(candidate, "hex")
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return { ok: true }
  }
  return { ok: false, code: "signature_invalid" }
}

export function payloadDigest(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex")
}

// ---------- Envelope ----------

const unix = z.number().int().nonnegative()
const envelopeSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{6,120}$/),
  object: z.literal("event"),
  type: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/),
  created: unix,
  livemode: z.boolean(),
  // Connect events carry the connected account here; a PLATFORM event never does.
  account: z.unknown().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
})

export type WebhookRefusal =
  | "invalid_json"
  | "invalid_envelope"
  | "connect_event_refused"
  | "live_event_refused"
  | "live_object_refused"
  | "invalid_object"

export type NormalizedEvent = {
  eventId: string
  eventType: string
  createdIso: string
  facts: Record<string, unknown>
}

export type ParsedWebhook =
  | { ok: true; kind: "handled"; event: NormalizedEvent }
  | { ok: true; kind: "ignored"; eventId: string; eventType: string }
  | { ok: false; code: WebhookRefusal }

const iso = (seconds: number | null | undefined): string | null =>
  typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null

const idOrNull = (value: unknown, pattern: RegExp): string | null =>
  typeof value === "string" && pattern.test(value) ? value : null

const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{4,120}$/
const SUB_ID = /^sub_[A-Za-z0-9_]{4,120}$/
const INVOICE_ID = /^in_[A-Za-z0-9_]{4,120}$/
const CURRENCY = /^[A-Za-z]{3}$/

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/**
 * The ONE subscription normalizer: used by the signed webhook and, unchanged, by polling reconciliation (PR F3), so a polled
 * subscription and a webhook subscription are judged by exactly the same rules (exact item set, period agreement).
 */
export function normalizeSubscription(object: Record<string, unknown>): Record<string, unknown> | null {
  const subId = idOrNull(object.id, SUB_ID)
  const customer = idOrNull(object.customer, CUSTOMER_ID)
  const status = typeof object.status === "string" ? object.status : null
  if (!subId || !customer || !status) return null
  const metadata = asRecord(object.metadata)
  const itemsRaw = asRecord(object.items).data
  const items = Array.isArray(itemsRaw) ? (itemsRaw as unknown[]).map(asRecord) : []
  // The EXACT Founder Pilot item set in any order (PR F2): licensed base x1 + the six reviewed metered Prices, by
  // lookup key. Anything else (missing, extra, duplicate, unknown, mismatched) is `invalid_items` → catalog_mismatch,
  // never "active". Metadata above is only a cross-check; the tenant is resolved by the database from server bindings.
  const exactItems = evaluateSubscriptionItems(itemsRaw).ok
  // Stripe moved the period from the subscription to its items in newer API versions. Accept
  // either, but only when every source that reports it agrees; a disagreement is an UNVERIFIED period.
  const topStart = typeof object.current_period_start === "number" ? object.current_period_start : null
  const topEnd = typeof object.current_period_end === "number" ? object.current_period_end : null
  const itemStarts = new Set(items.map((item) => item.current_period_start).filter((v): v is number => typeof v === "number"))
  const itemEnds = new Set(items.map((item) => item.current_period_end).filter((v): v is number => typeof v === "number"))
  const itemStart = itemStarts.size === 1 ? [...itemStarts][0] : null
  const itemEnd = itemEnds.size === 1 ? [...itemEnds][0] : null
  let start = topStart ?? itemStart
  let end = topEnd ?? itemEnd
  if (
    itemStarts.size > 1 ||
    itemEnds.size > 1 ||
    (topStart !== null && itemStart !== null && topStart !== itemStart) ||
    (topEnd !== null && itemEnd !== null && topEnd !== itemEnd)
  ) {
    start = null
    end = null
  }
  if (start === null || end === null || end <= start) {
    start = null
    end = null
  }
  return {
    object: "subscription",
    subscription_id: subId,
    customer_id: customer,
    status,
    catalog_version: typeof metadata.catalog_version === "string" ? metadata.catalog_version : "",
    plan_key: typeof metadata.plan_key === "string" ? metadata.plan_key : "",
    metadata_shop_id: typeof metadata.shop_id === "string" ? metadata.shop_id : null,
    checkout_attempt_id: typeof metadata.checkout_attempt_id === "string" ? metadata.checkout_attempt_id : null,
    price_lookup_key: exactItems ? FOUNDER_PILOT_PRICE.lookupKey : "invalid_items",
    period_start: iso(start),
    period_end: iso(end),
    started_at: iso(typeof object.start_date === "number" ? object.start_date : null),
    cancel_at_period_end: typeof object.cancel_at_period_end === "boolean" ? object.cancel_at_period_end : null,
    canceled_at: iso(typeof object.canceled_at === "number" ? object.canceled_at : null),
  }
}

function normalizeInvoice(object: Record<string, unknown>, outcome: "payment_failed" | "payment_succeeded") {
  const invoiceId = idOrNull(object.id, INVOICE_ID)
  const customer = idOrNull(object.customer, CUSTOMER_ID)
  if (!invoiceId || !customer) return null
  const parent = asRecord(asRecord(object.parent).subscription_details)
  const subscription = idOrNull(object.subscription, SUB_ID) ?? idOrNull(parent.subscription, SUB_ID)
  const amount = outcome === "payment_failed" ? object.amount_due : object.amount_paid
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) return null
  const currency = typeof object.currency === "string" && CURRENCY.test(object.currency) ? object.currency.toLowerCase() : null
  return {
    object: "invoice",
    outcome,
    invoice_id: invoiceId,
    customer_id: customer,
    subscription_id: subscription,
    amount_cents: amount,
    currency,
    attempt_count: typeof object.attempt_count === "number" && Number.isInteger(object.attempt_count) ? object.attempt_count : null,
  }
}

function normalizeMoneyObject(object: Record<string, unknown>, kind: "charge" | "credit_note") {
  const objectId = idOrNull(object.id, kind === "charge" ? /^(ch|py)_[A-Za-z0-9_]{4,120}$/ : /^cn_[A-Za-z0-9_]{4,120}$/)
  const customer = idOrNull(object.customer, CUSTOMER_ID)
  if (!objectId || !customer) return null
  const amount = kind === "charge" ? object.amount_refunded : typeof object.amount === "number" ? object.amount : object.total
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) return null
  const currency = typeof object.currency === "string" && CURRENCY.test(object.currency) ? object.currency.toLowerCase() : null
  return {
    object: kind,
    object_id: objectId,
    customer_id: customer,
    invoice_id: idOrNull(object.invoice, INVOICE_ID),
    subscription_id: null,
    amount_cents: amount,
    currency,
  }
}

function normalizeCheckout(object: Record<string, unknown>, outcome: "completed" | "expired") {
  const sessionId = typeof object.id === "string" ? object.id : null
  if (!sessionId) return null
  // A live-shaped session id is refused by the caller before this point; here only test ids pass.
  if (!/^cs_test_[A-Za-z0-9_]{4,200}$/.test(sessionId)) return null
  return {
    object: "checkout_session",
    outcome,
    session_id: sessionId,
    customer_id: idOrNull(object.customer, CUSTOMER_ID),
    subscription_id: idOrNull(object.subscription, SUB_ID),
  }
}

/**
 * Parses and classifies a body whose signature has ALREADY verified. Refuses Connect
 * envelopes, live-mode events and live-mode objects before anything is normalized.
 */
export function parseVerifiedWebhook(rawBody: string): ParsedWebhook {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { ok: false, code: "invalid_json" }
  }
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) return { ok: false, code: "invalid_envelope" }
  const event = envelope.data
  // A Connect event (any `account`, even null-ish truthy) never belongs on this endpoint.
  if (event.account !== undefined && event.account !== null) return { ok: false, code: "connect_event_refused" }
  if (event.livemode !== false) return { ok: false, code: "live_event_refused" }
  const object = event.data.object
  // Every provider object must positively say it is test mode; absence is not assumed safe.
  if (object.livemode !== false) return { ok: false, code: "live_object_refused" }
  if (typeof object.id === "string" && /_live_/.test(object.id)) return { ok: false, code: "live_object_refused" }

  const created = iso(event.created) as string
  const handled = (facts: Record<string, unknown> | null): ParsedWebhook =>
    facts
      ? { ok: true, kind: "handled", event: { eventId: event.id, eventType: event.type, createdIso: created, facts } }
      : { ok: false, code: "invalid_object" }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handled(normalizeSubscription(object))
    case "invoice.payment_failed":
      return handled(normalizeInvoice(object, "payment_failed"))
    case "invoice.payment_succeeded":
    case "invoice.paid":
      return handled(normalizeInvoice(object, "payment_succeeded"))
    case "charge.refunded":
      return handled(normalizeMoneyObject(object, "charge"))
    case "credit_note.created":
      return handled(normalizeMoneyObject(object, "credit_note"))
    case "checkout.session.completed":
    case "checkout.session.expired":
      // Only subscription Checkouts are ours; anything else is not this endpoint's business.
      if (object.mode !== "subscription") return { ok: true, kind: "ignored", eventId: event.id, eventType: event.type }
      return handled(normalizeCheckout(object, event.type.endsWith("completed") ? "completed" : "expired"))
    default:
      return { ok: true, kind: "ignored", eventId: event.id, eventType: event.type }
  }
}
