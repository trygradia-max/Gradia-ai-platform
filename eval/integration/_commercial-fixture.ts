import { expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import {
  REVIEWED_VALUE_BASIS,
  SETTLEMENT_COMPONENTS,
  type MeterMapping,
} from "@/lib/commercial-settlement"
import type { SettlementRuntime } from "@/lib/commercial-settlement-service"
import { createSettlementProvider } from "@/lib/commercial-settlement-provider"
import { recognizeCommercialUsage } from "@/lib/commercial-usage-service"
import { SANDBOX_METERS } from "@/lib/stripe-sandbox-contract"
import { assertDisposableTarget, seedShop, type Seeded } from "./_db"
import type { FakeStripeSandbox } from "../_fake-stripe-sandbox"

/** Shared fixtures for the PR F sandbox suites. Disposable stack only (asserted). */
export const PW = "Synthetic-password-123!"
export const DAY_S = 86_400
export const FAKE_CONFIG = { secretKey: "sk_test_FAKEFAKEFAKEFAKE0123", apiBase: "https://api.stripe.com/v1", timeoutMs: 5_000 }

let seq = 0
export const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`.replace(/[^A-Za-z0-9]/g, "")

export async function transient<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i < 4; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!/invalid response was received from the upstream server/i.test(String((e as Error)?.message))) throw e
      await new Promise((r) => setTimeout(r, 250 * (i + 1)))
    }
  }
  throw last
}

/** Fixture-only SQL through the stack's pg-meta endpoint (target asserted). */
export async function sql(query: string): Promise<{ ok: boolean; rows: unknown; message?: string }> {
  assertDisposableTarget()
  const key = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY as string
  const res = await fetch(`${process.env.SUPABASE_TEST_URL}/pg/query`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ query }),
  })
  const body = (await res.json()) as unknown
  if (!res.ok) return { ok: false, rows: null, message: String((body as { message?: string; error?: string })?.message ?? (body as { error?: string })?.error ?? res.status) }
  return { ok: true, rows: body }
}

/** A provisioned mapping built from the sandbox CONTRACT names (what a reviewed commit would carry). */
export const CONTRACT_MAPPING: MeterMapping = {
  version: "settlement-mapping.f1-fixture",
  status: "provisioned",
  entries: SETTLEMENT_COMPONENTS.map((component) => ({
    component,
    valueBasis: REVIEWED_VALUE_BASIS[component],
    eventName: SANDBOX_METERS.find((m) => m.component === component)!.eventName,
  })),
}

export const runtimeFor = (fake: FakeStripeSandbox): SettlementRuntime => ({
  ok: true,
  provider: createSettlementProvider(FAKE_CONFIG, fake.request),
  mapping: CONTRACT_MAPPING,
})

/** Window helpers: UTC-midnight aligned instants. */
export const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

export type Fixture = { shop: Seeded; customerId: string; subscriptionId: string; extra: Seeded[] }

/**
 * A workspace with a bound platform customer, a verified Stripe period [start, end) seeded
 * through the single evidence writer, and membership coverage backdated to before `start`.
 */
export async function settleableShop(
  db: SupabaseClient,
  seeded: Seeded[],
  window: { startS: number; endS: number },
  opts: { extraOperators?: number } = {}
): Promise<Fixture> {
  const mk = async (password = false) => {
    const s = await transient(() => seedShop(db, password ? { password: PW } : undefined))
    seeded.push(s)
    return s
  }
  const shop = await mk(true)
  const extra: Seeded[] = []
  for (let i = 0; i < (opts.extraOperators ?? 3); i++) {
    const u = await mk()
    extra.push(u)
    const r = await db
      .from("shop_memberships")
      .upsert({ shop_id: shop.shopId, user_id: u.ownerId, role: i % 2 ? "staff" : "manager", capabilities: [], active: true, display_name: `m${i}` }, { onConflict: "shop_id,user_id" })
    expect(r.error).toBeNull()
  }
  const backdate = iso(window.startS - DAY_S)
  const r = await sql(`
    ALTER TABLE public.commercial_membership_events DISABLE TRIGGER commercial_membership_events_append_only;
    ALTER TABLE public.commercial_membership_coverage DISABLE TRIGGER commercial_membership_coverage_append_only;
    UPDATE public.commercial_membership_events SET effective_at='${backdate}', recorded_at='${backdate}' WHERE shop_id='${shop.shopId}';
    UPDATE public.commercial_membership_coverage SET covered_from='${backdate}', recorded_at='${backdate}' WHERE shop_id='${shop.shopId}';
    ALTER TABLE public.commercial_membership_events ENABLE TRIGGER commercial_membership_events_append_only;
    ALTER TABLE public.commercial_membership_coverage ENABLE TRIGGER commercial_membership_coverage_append_only;`)
  expect(r.ok, r.message).toBe(true)

  const customerId = `cus_F1${uniq()}`
  const begun = await db.rpc("commercial_checkout_begin", {
    p_shop: shop.shopId, p_actor: shop.ownerId, p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
    p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: "f".repeat(64),
  })
  expect(begun.error).toBeNull()
  expect((await db.rpc("commercial_checkout_bind_customer", {
    p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: (begun.data as { attempt_id: string }).attempt_id, p_customer: customerId })).error).toBeNull()
  const subscriptionId = `sub_F1${uniq()}`
  const evidence = await db.rpc("commercial_subscription_apply_evidence", {
    p_shop: shop.shopId, p_subscription: subscriptionId, p_customer: customerId, p_status: "active",
    p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey,
    p_source: "reviewed_reconciliation", p_event_id: `evt_f1_${uniq()}`, p_event_created_at: iso(window.startS), p_livemode: false,
    p_period_start: iso(window.startS), p_period_end: iso(window.endS), p_started_at: iso(window.startS),
  })
  expect(evidence.error).toBeNull()
  return { shop, customerId, subscriptionId, extra }
}

export async function recognizeOutcomes(db: SupabaseClient, shopId: string, metric: string, count: number, atS: number) {
  const tag = uniq()
  for (let i = 0; i < count; i++) {
    const r = await recognizeCommercialUsage(db, {
      kind: "outcome", shopId, metric: metric as "confirmed_appointment", workflowKey: `${tag}-${metric}-${i}`, sourceRef: `wf:${tag}-${metric}-${i}`,
      outcome: { state: "confirmed", humanCompleted: false }, recognizedAt: iso(atS),
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
}

export async function recognizeSms(db: SupabaseClient, shopId: string, quantity: number, cost: string, atS: number) {
  const ev = await db.from("usage_events").insert({ shop_id: shopId, kind: "sms_segment", quantity, credits: 0, vendor_ref: `f1-${uniq()}`, ref_id: `ref-${uniq()}` }).select("id").single()
  expect(ev.error).toBeNull()
  const r = await recognizeCommercialUsage(db, {
    kind: "provider_usage", shopId, metric: "sms_segment", usageEventId: ev.data!.id as string, sourceRef: `provider:${ev.data!.id}`,
    quantity: String(quantity), direction: "outbound", recognizedAt: iso(atS),
    wholesale: { unitCostCents: cost, basis: "provider_reported" as const },
  })
  expect(r.ok, JSON.stringify(r)).toBe(true)
}

export async function rows<T = Record<string, unknown>>(db: SupabaseClient, table: string, shopId: string, order = "id"): Promise<T[]> {
  const r = await db.from(table).select("*").eq("shop_id", shopId).order(order)
  expect(r.error).toBeNull()
  return r.data as T[]
}
