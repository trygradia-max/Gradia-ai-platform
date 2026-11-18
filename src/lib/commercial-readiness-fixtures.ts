import { createHmac } from "node:crypto"

import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import {
  FOUNDER_PILOT_ITEM_SLOTS,
  buildFounderPilotLineItems,
  evaluateSubscriptionItems,
} from "@/lib/commercial-subscription-items"
import { WORKER_ENABLE_FLAG, resolveCommercialWorkerConfig } from "@/lib/commercial-billing-worker"
import { parseVerifiedWebhook, verifyCommercialSignature } from "@/lib/commercial-webhook"
import { REVIEWED_SETTLEMENT_METER_MAPPING, SETTLEMENT_COMPONENTS } from "@/lib/commercial-settlement"
import { COMMERCIAL_METER_API_VERSION, SANDBOX_METERS, mappingMatchesSandboxContract } from "@/lib/stripe-sandbox-contract"
import type { MeterMapping } from "@/lib/commercial-settlement"

/**
 * Offline LOCAL-FIXTURE readiness checks (PR F2). No network, no database, no secrets. They prove the committed
 * contract is internally consistent and that the production webhook rule accepts exactly the contract item set and
 * refuses every mutation, using fixtures built from the contract itself. They say NOTHING about a real Stripe
 * sandbox: the report always labels real acceptance separately, and "NOT RUN" unless real evidence is supplied.
 */

export type LocalCheck = { id: string; ok: boolean }

const price = (slot: (typeof FOUNDER_PILOT_ITEM_SLOTS)[number]) => ({
  id: `price_${slot.slot}`, livemode: false, currency: "usd", lookup_key: slot.lookupKey, type: "recurring", billing_scheme: "per_unit",
  unit_amount: slot.unitAmountCents, product: "prod_fixture",
  recurring: { interval: "month", interval_count: 1, usage_type: slot.usageType, ...(slot.usageType === "metered" ? { meter: `mtr_${slot.slot}` } : {}) },
})
const item = (slot: (typeof FOUNDER_PILOT_ITEM_SLOTS)[number]) => ({ ...(slot.usageType === "licensed" ? { quantity: 1 } : {}), price: price(slot) })

function webhookFacts(items: unknown[]): Record<string, unknown> | null {
  const secret = `whsec_${"a1".repeat(16)}`
  const body = JSON.stringify({
    id: "evt_readinessfixture1", object: "event", type: "customer.subscription.updated", created: 1_790_000_100, livemode: false,
    data: { object: { id: "sub_readiness01", object: "subscription", customer: "cus_readiness01", status: "active", livemode: false, start_date: 1_790_000_000, current_period_start: 1_790_000_000, current_period_end: 1_792_592_000, cancel_at_period_end: false, canceled_at: null, metadata: {}, items: { data: items } } },
  })
  const t = 1_790_000_100
  const header = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`
  if (!verifyCommercialSignature({ rawBody: body, header, secret, nowMs: t * 1000 }).ok) return null
  const parsed = parseVerifiedWebhook(body)
  return parsed.ok && parsed.kind === "handled" ? parsed.event.facts : null
}

export function runLocalFixtureChecks(mapping: MeterMapping = REVIEWED_SETTLEMENT_METER_MAPPING): LocalCheck[] {
  const exact = FOUNDER_PILOT_ITEM_SLOTS.map(item)
  const accepts = (items: unknown[]) => webhookFacts(items)?.price_lookup_key === FOUNDER_PILOT_PRICE.lookupKey
  const refuses = (items: unknown[]) => webhookFacts(items)?.price_lookup_key === "invalid_items"
  const slots = FOUNDER_PILOT_ITEM_SLOTS

  const checks: LocalCheck[] = []
  checks.push({
    id: "f1_contract_consistent",
    ok:
      slots.length === 1 + SETTLEMENT_COMPONENTS.length &&
      new Set(slots.map((s) => s.lookupKey)).size === slots.length &&
      SANDBOX_METERS.length === SETTLEMENT_COMPONENTS.length &&
      SANDBOX_METERS.every((m) => slots.some((s) => s.lookupKey === m.meteredPriceLookupKey && s.unitAmountCents === m.meteredUnitAmountCents)) &&
      new Set(SANDBOX_METERS.map((m) => m.eventName)).size === SANDBOX_METERS.length &&
      COMMERCIAL_METER_API_VERSION === "2024-09-30.acacia",
  })
  checks.push({ id: "settlement_mapping_equals_contract", ok: mappingMatchesSandboxContract(mapping) })
  checks.push({
    id: "exact_item_set_accepted_any_order",
    ok: evaluateSubscriptionItems(exact).ok && evaluateSubscriptionItems([...exact].reverse()).ok &&
      buildFounderPilotLineItems({ base: "price_b", metered: Object.fromEntries(SANDBOX_METERS.map((m) => [m.component, `price_${m.component}`])) })?.length === 7,
  })
  checks.push({ id: "webhook_accepts_exact_items", ok: accepts(exact) && accepts([...exact].reverse()) })
  const wrongQuantity = [{ ...exact[0], quantity: 2 }, ...exact.slice(1)]
  const wrongAmount = [exact[0], { ...exact[1], price: { ...exact[1].price, unit_amount: 1 } }, ...exact.slice(2)]
  checks.push({
    id: "webhook_refuses_missing_extra_duplicate_mismatched_items",
    ok:
      refuses(exact.slice(0, 1)) && refuses(exact.slice(0, 6)) && refuses([...exact, exact[1]]) && refuses([...exact.slice(0, 6), exact[1]]) &&
      refuses([...exact.slice(0, 6), { quantity: 1, price: { lookup_key: "gradia_operator_seat_2026_11_monthly" } }]) &&
      refuses(wrongQuantity) && refuses(wrongAmount) && refuses([]),
  })
  // The worker must be reachable only through explicit, test-shaped configuration and the exact mapping.
  const testEnv = { [WORKER_ENABLE_FLAG]: "enabled", GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_test_FIXTUREFIXTURE0123" }
  const liveEnv = { ...testEnv, STRIPE_SECRET_KEY: "sk_live_FIXTUREFIXTURE0123" }
  checks.push({
    id: "worker_fails_closed",
    ok:
      resolveCommercialWorkerConfig({}, mapping).ok === false &&
      resolveCommercialWorkerConfig(liveEnv, mapping).ok === false &&
      resolveCommercialWorkerConfig(testEnv, { ...mapping, status: "unprovisioned" }).ok === false &&
      resolveCommercialWorkerConfig(testEnv, mapping).ok === true,
  })
  return checks
}
