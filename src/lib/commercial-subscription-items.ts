import { createHash } from "node:crypto"

import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { SANDBOX_METERS, COMMERCIAL_METER_API_VERSION } from "@/lib/stripe-sandbox-contract"
import type { SettlementComponent } from "@/lib/commercial-settlement"

/**
 * The exact Founder Pilot subscription item set (Commercial Billing PR F2). Pure: no clock, no
 * network, no Stripe object ids.
 *
 * One deterministic set: the approved LICENSED base Price (quantity 1) plus EXACTLY the six reviewed
 * METERED Prices, identified only by lookup key, in ANY order. Anything else is refused:
 * a missing, extra, duplicate or unknown item, a wrong amount / currency / interval / usage type, a
 * live-mode price, a metered item without a meter, a licensed quantity other than 1, a metered item
 * carrying a quantity, or items that do not share one Product. This module is the single rule used by
 *   - Checkout creation/retrieval verification (`stripe-commercial.ts`), and
 *   - signed subscription-webhook normalization (`commercial-webhook.ts`).
 * Metadata is never an input here. Tenant never comes from here.
 *
 * Webhook scope note: a subscription event carries Price objects but no Stripe client is available on
 * that path, so it cannot prove which Meter a metered Price is wired to (it only requires that one is
 * present). The meter identity is verified, read-only, at Checkout time and by the readiness command
 * (`evaluateSandboxReadiness`), which is why Checkout resolves the set from a verified snapshot.
 */

export const FOUNDER_PILOT_ITEM_SET_VERSION = "founder-pilot-items.v1"
export const FOUNDER_PILOT_ITEM_SET_API_VERSION = COMMERCIAL_METER_API_VERSION

export type ItemSlot = {
  slot: "base" | SettlementComponent
  lookupKey: string
  usageType: "licensed" | "metered"
  unitAmountCents: number
}

export const FOUNDER_PILOT_ITEM_SLOTS: readonly ItemSlot[] = [
  { slot: "base", lookupKey: FOUNDER_PILOT_PRICE.lookupKey, usageType: "licensed", unitAmountCents: FOUNDER_PILOT_PRICE.unitAmountCents },
  ...SANDBOX_METERS.map((meter) => ({
    slot: meter.component,
    lookupKey: meter.meteredPriceLookupKey,
    usageType: "metered" as const,
    unitAmountCents: meter.meteredUnitAmountCents,
  })),
]

/** Stable fingerprint of the contract: changes whenever a lookup key, amount, usage type or version changes. */
export const FOUNDER_PILOT_ITEM_SET_DIGEST = createHash("sha256")
  .update(JSON.stringify([FOUNDER_PILOT_ITEM_SET_VERSION, FOUNDER_PILOT_ITEM_SET_API_VERSION, FOUNDER_PILOT_ITEM_SLOTS]))
  .digest("hex")

export type ItemSetFinding =
  | "items_unreadable"
  | "item_count_mismatch"
  | "item_unreadable"
  | "item_unknown_price"
  | "item_duplicate"
  | "item_missing"
  | "item_quantity_mismatch"
  | "item_price_mismatch"
  | "item_live"
  | "item_meter_missing"
  | "item_product_mismatch"

export type ItemSetEvaluation = { ok: true } | { ok: false; findings: ItemSetFinding[] }

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const productId = (value: unknown): string | null => {
  if (typeof value === "string" && value.length > 0) return value
  const object = record(value)
  return object && typeof object.id === "string" && object.id.length > 0 ? object.id : null
}

/**
 * Judges the items of a subscription (webhook) or the line items of a Checkout Session against the exact
 * set. The same input always gives the same findings in the same order. Order of the items is irrelevant.
 */
export function evaluateSubscriptionItems(items: unknown): ItemSetEvaluation {
  if (!Array.isArray(items)) return { ok: false, findings: ["items_unreadable"] }
  const findings = new Set<ItemSetFinding>()
  if (items.length !== FOUNDER_PILOT_ITEM_SLOTS.length) findings.add("item_count_mismatch")

  const seen = new Set<string>()
  const products = new Set<string>()
  for (const raw of items) {
    const item = record(raw)
    const price = record(item?.price)
    if (!item || !price) {
      findings.add("item_unreadable")
      continue
    }
    const lookupKey = price.lookup_key
    const slot = typeof lookupKey === "string" ? FOUNDER_PILOT_ITEM_SLOTS.find((candidate) => candidate.lookupKey === lookupKey) : undefined
    if (!slot) {
      findings.add("item_unknown_price")
      continue
    }
    if (seen.has(slot.lookupKey)) findings.add("item_duplicate")
    seen.add(slot.lookupKey)

    if (price.livemode !== false) findings.add("item_live")
    const recurring = record(price.recurring)
    if (
      price.currency !== FOUNDER_PILOT_PRICE.currency ||
      price.unit_amount !== slot.unitAmountCents ||
      (price.type !== undefined && price.type !== "recurring") ||
      (price.billing_scheme !== undefined && price.billing_scheme !== "per_unit") ||
      !recurring ||
      recurring.interval !== FOUNDER_PILOT_PRICE.interval ||
      recurring.interval_count !== 1 ||
      recurring.usage_type !== slot.usageType
    ) {
      findings.add("item_price_mismatch")
    }
    if (slot.usageType === "licensed") {
      // The licensed base is exactly one workspace subscription. Seats and usage are never quantities here.
      if (item.quantity !== 1) findings.add("item_quantity_mismatch")
    } else {
      // Stripe: quantity is not defined for metered prices (nullable on the item).
      if (item.quantity !== undefined && item.quantity !== null) findings.add("item_quantity_mismatch")
      if (!recurring || typeof recurring.meter !== "string" || recurring.meter.length === 0) findings.add("item_meter_missing")
    }
    const product = productId(price.product)
    if (product === null) findings.add("item_product_mismatch")
    else products.add(product)
  }
  if (products.size > 1) findings.add("item_product_mismatch")
  for (const slot of FOUNDER_PILOT_ITEM_SLOTS) {
    if (!seen.has(slot.lookupKey)) findings.add("item_missing")
  }
  if (findings.size === 0) return { ok: true }
  const order: ItemSetFinding[] = [
    "items_unreadable", "item_count_mismatch", "item_unreadable", "item_unknown_price", "item_duplicate", "item_missing",
    "item_quantity_mismatch", "item_price_mismatch", "item_live", "item_meter_missing", "item_product_mismatch",
  ]
  return { ok: false, findings: order.filter((code) => findings.has(code)) }
}

export type CheckoutLineItem = { priceId: string; /** Absent for metered Prices (Stripe: quantity must not be defined). */ quantity?: 1 }

/**
 * The Checkout line items for verified provider Price ids: the licensed base at quantity 1, then each
 * metered Price in contract order with NO quantity. Deterministic; inputs are ids resolved at run time.
 */
export function buildFounderPilotLineItems(prices: { base: string; metered: Partial<Record<SettlementComponent, string>> }): CheckoutLineItem[] | null {
  const items: CheckoutLineItem[] = [{ priceId: prices.base, quantity: 1 }]
  for (const meter of SANDBOX_METERS) {
    const id = prices.metered[meter.component]
    if (typeof id !== "string" || id.length === 0) return null
    items.push({ priceId: id })
  }
  const ids = items.map((item) => item.priceId)
  return new Set(ids).size === ids.length ? items : null
}
