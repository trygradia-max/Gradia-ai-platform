import { describe, expect, it } from "vitest"

import { REVIEWED_VALUE_BASIS, SETTLEMENT_COMPONENTS, type SettlementDocument } from "@/lib/commercial-settlement"
import { StripeError } from "@/lib/stripe"
import {
  COMMERCIAL_METER_API_VERSION,
  SANDBOX_BASE_PRICE,
  SANDBOX_MANUAL_STEPS,
  SANDBOX_METERS,
  authorizeInvoiceReconstruction,
  evaluateSandboxReadiness,
  reconstructInvoiceFromDocument,
  type SandboxSnapshot,
} from "@/lib/stripe-sandbox-contract"
import { collectSandboxSnapshot, verifyStripeSandbox } from "@/lib/stripe-sandbox-verifier"
import { FakeStripeSandbox } from "./_fake-stripe-sandbox"

const config = { secretKey: "sk_test_FAKEFAKEFAKEFAKE0123", apiBase: "https://api.stripe.com/v1", timeoutMs: 5_000 }
const GOOD_ENV = { GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test", STRIPE_SECRET_KEY: config.secretKey }

async function snapshotOf(fake: FakeStripeSandbox): Promise<SandboxSnapshot> {
  const snap = await collectSandboxSnapshot(config, fake.request)
  if ("failure" in snap) throw new Error("unreachable")
  return snap
}
const codes = (snap: SandboxSnapshot) => evaluateSandboxReadiness(snap).findings.map((f) => `${f.code}:${f.subject}`)

describe("sandbox contract (proposal, no object ids)", () => {
  it("derives every metered unit price from the approved catalog", () => {
    const unit = Object.fromEntries(SANDBOX_METERS.map((m) => [m.component, m.meteredUnitAmountCents]))
    expect(unit).toEqual({
      standard_digital_outcome: 100, qualified_lead: 500, confirmed_appointment: 1000,
      inbound_voice_agent_minute: 1, sms_segment: 1, extra_operator_seat_proration: 1,
    })
    for (const meter of SANDBOX_METERS) expect(meter.valueBasis).toBe(REVIEWED_VALUE_BASIS[meter.component])
    expect(SANDBOX_BASE_PRICE).toMatchObject({ unitAmountCents: 19_900, interval: "month", currency: "usd", lookupKey: "gradia_founder_pilot_2026_11_monthly" })
  })
  it("has one unique, well-formed event name and lookup key per approved component and no provider ids", () => {
    expect(SANDBOX_METERS.map((m) => m.component)).toEqual([...SETTLEMENT_COMPONENTS])
    expect(new Set(SANDBOX_METERS.map((m) => m.eventName)).size).toBe(6)
    expect(new Set(SANDBOX_METERS.map((m) => m.meteredPriceLookupKey)).size).toBe(6)
    for (const m of SANDBOX_METERS) expect(m.eventName).toMatch(/^[a-z][a-z0-9_]{2,99}$/)
    expect(JSON.stringify([SANDBOX_METERS, SANDBOX_BASE_PRICE])).not.toMatch(/\b(prod|price|mtr|cus|sk|rk|whsec)_[A-Za-z0-9]/)
  })
  it("pins one meter API version, distinct from the older adapter pin", () => {
    expect(COMMERCIAL_METER_API_VERSION).toBe("2024-09-30.acacia")
  })
  it("lists manual Dashboard steps and never claims any was done", () => {
    expect(SANDBOX_MANUAL_STEPS.length).toBeGreaterThanOrEqual(8)
    expect(SANDBOX_MANUAL_STEPS.map((s) => s.text).join(" ")).not.toMatch(/\b(done|completed|already created)\b/i)
  })
})

describe("sandbox readiness (refuse, never repair)", () => {
  it("a contract-conformant sandbox is READY and every meter id is verified", async () => {
    const result = evaluateSandboxReadiness(await snapshotOf(FakeStripeSandbox.provisioned(1_800_000_000)))
    expect(result).toMatchObject({ ready: true, findings: [] })
    expect(Object.keys(result.verifiedMeterIds)).toHaveLength(6)
  })

  it("is read-only: only GET, platform, the reviewed API version, no idempotency key", async () => {
    const fake = FakeStripeSandbox.provisioned(1_800_000_000)
    await snapshotOf(fake)
    expect(fake.calls.length).toBeGreaterThan(0)
    expect(fake.calls.every((c) => c.method === "GET" && c.apiVersion === COMMERCIAL_METER_API_VERSION && c.idempotencyKey === undefined)).toBe(true)
  })

  it("refuses an empty sandbox with a finite, ordered list", async () => {
    const snap = await snapshotOf(new FakeStripeSandbox(1_800_000_000))
    const found = codes(snap)
    expect(found).toContain("price_missing:base_price")
    expect(found.filter((c) => c.startsWith("meter_missing"))).toHaveLength(6)
    expect(found.filter((c) => c.startsWith("price_missing"))).toHaveLength(7)
    expect(found).toEqual([...found].sort())
    expect(evaluateSandboxReadiness(snap).ready).toBe(false)
  })

  const mutations: [string, (f: FakeStripeSandbox) => void, string][] = [
    ["absent meter", (f) => { f.meters = f.meters.filter((m) => m.component !== "sms_segment") }, "meter_missing:sms_segment"],
    ["duplicate active meter", (f) => { f.meters.push({ ...f.meters[0], id: "mtr_test_dup" }) }, "meter_duplicate:standard_digital_outcome"],
    ["inactive meter", (f) => { f.meters[1].status = "inactive" }, "meter_inactive:qualified_lead"],
    ["live meter", (f) => { f.meters[2].livemode = true }, "meter_live:confirmed_appointment"],
    ["wrong aggregation", (f) => { f.meters[3].default_aggregation = { formula: "max" } }, "meter_aggregation_mismatch:inbound_voice_agent_minute"],
    ["wrong customer mapping", (f) => { f.meters[3].customer_mapping = { type: "by_id", event_payload_key: "cust" } }, "meter_customer_mapping_mismatch:inbound_voice_agent_minute"],
    ["wrong value key", (f) => { f.meters[4].value_settings = { event_payload_key: "amount" } }, "meter_value_key_mismatch:sms_segment"],
    ["pre-aggregated meter", (f) => { f.meters[4].event_time_window = "hour" }, "meter_time_window_mismatch:sms_segment"],
    ["absent base price", (f) => { delete f.prices[SANDBOX_BASE_PRICE.lookupKey] }, "price_missing:base_price"],
    ["duplicate base price", (f) => { f.prices[SANDBOX_BASE_PRICE.lookupKey].push(f.prices[SANDBOX_BASE_PRICE.lookupKey][0]) }, "price_duplicate:base_price"],
    ["live base price", (f) => { (f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { livemode: boolean }).livemode = true }, "price_live:base_price"],
    ["inactive base price", (f) => { (f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { active: boolean }).active = false }, "price_inactive:base_price"],
    ["wrong currency", (f) => { (f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { currency: string }).currency = "eur" }, "price_currency_mismatch:base_price"],
    ["wrong amount", (f) => { (f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { unit_amount: number }).unit_amount = 14_900 }, "price_amount_mismatch:base_price"],
    ["wrong interval", (f) => { (f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { recurring: { interval: string } }).recurring.interval = "year" }, "price_interval_mismatch:base_price"],
    ["metered base price", (f) => { (f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { recurring: { usage_type: string } }).recurring.usage_type = "metered" }, "price_usage_type_mismatch:base_price"],
    ["tiered scheme", (f) => { (f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { billing_scheme: string }).billing_scheme = "tiered" }, "price_scheme_mismatch:base_price"],
    ["metered price on the wrong meter", (f) => { (f.prices[SANDBOX_METERS[0].meteredPriceLookupKey][0] as { recurring: { meter: string } }).recurring.meter = "mtr_test_other" }, "price_meter_mismatch:standard_digital_outcome"],
    ["wrong metered amount", (f) => { (f.prices[SANDBOX_METERS[1].meteredPriceLookupKey][0] as { unit_amount: number }).unit_amount = 400 }, "price_amount_mismatch:qualified_lead"],
    ["wrong product name", (f) => { ((f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { product: { name: string } }).product).name = "Other" }, "product_name_mismatch:base_price"],
    ["wrong product metadata", (f) => { ((f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { product: { metadata: Record<string, string> } }).product).metadata = {} }, "product_metadata_mismatch:base_price"],
    ["live product", (f) => { ((f.prices[SANDBOX_BASE_PRICE.lookupKey][0] as { product: { livemode: boolean } }).product).livemode = true }, "product_live:base_price"],
    ["wrong API version", (f) => { f.echoedVersion = "2024-06-20" }, "api_version_mismatch:api_version"],
    ["API version not echoed", (f) => { f.echoedVersion = null }, "api_version_not_echoed:api_version"],
  ]
  it.each(mutations)("refuses %s", async (_name, mutate, expected) => {
    const fake = FakeStripeSandbox.provisioned(1_800_000_000)
    mutate(fake)
    const result = evaluateSandboxReadiness(await snapshotOf(fake))
    expect(result.ready).toBe(false)
    expect(result.findings.map((f) => `${f.code}:${f.subject}`)).toContain(expected)
  })

  it("an incomplete or unreadable meter list is a refusal, not a pass", async () => {
    const snap = await snapshotOf(FakeStripeSandbox.provisioned(1_800_000_000))
    expect(codes({ ...snap, metersComplete: false })).toContain("meters_list_incomplete:meters")
    expect(codes({ ...snap, meters: null })).toContain("meters_unreadable:meters")
    expect(codes({ ...snap, pricesByLookupKey: { ...snap.pricesByLookupKey, [SANDBOX_BASE_PRICE.lookupKey]: [{ nonsense: true }] } })).toContain("price_unreadable:base_price")
  })

  it("is deterministic: the same snapshot gives the same findings in the same order", async () => {
    const fake = FakeStripeSandbox.provisioned(1_800_000_000)
    fake.meters = []
    delete fake.prices[SANDBOX_BASE_PRICE.lookupKey]
    const snap = await snapshotOf(fake)
    expect(evaluateSandboxReadiness(snap)).toEqual(evaluateSandboxReadiness(snap))
  })
})

describe("verifyStripeSandbox (configuration and failure handling)", () => {
  it("does not touch the provider when billing is unconfigured, misconfigured or live-shaped", async () => {
    const fake = FakeStripeSandbox.provisioned(1)
    expect(await verifyStripeSandbox({}, fake.request)).toEqual({ status: "not_run", reason: "billing_unconfigured" })
    expect(await verifyStripeSandbox({ ...GOOD_ENV, STRIPE_SECRET_KEY: "sk_live_FAKEFAKEFAKEFAKE0123" }, fake.request)).toEqual({ status: "not_run", reason: "billing_misconfigured" })
    expect(await verifyStripeSandbox({ ...GOOD_ENV, GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "live" }, fake.request)).toEqual({ status: "not_run", reason: "billing_misconfigured" })
    expect(fake.calls).toHaveLength(0)
  })
  it("reports READY for a conformant sandbox and not_run when the provider is unreachable", async () => {
    expect(await verifyStripeSandbox(GOOD_ENV, FakeStripeSandbox.provisioned(1).request)).toMatchObject({ status: "checked", ready: true })
    const down = (async () => { throw new StripeError(0, "down", "network_error") }) as never
    expect(await verifyStripeSandbox(GOOD_ENV, down)).toEqual({ status: "not_run", reason: "provider_unreachable" })
  })
})

// ---------- invoice reconstruction ----------
const doc = (over: Partial<Record<(typeof SETTLEMENT_COMPONENTS)[number], { billed: string; cents: number }>> = {}, tweak: Partial<SettlementDocument> = {}): SettlementDocument => {
  const base: Record<string, { billed: string; cents: number }> = {
    standard_digital_outcome: { billed: "5", cents: 500 }, qualified_lead: { billed: "2", cents: 1000 }, confirmed_appointment: { billed: "1", cents: 1000 },
    inbound_voice_agent_minute: { billed: "12", cents: 420 }, sms_segment: { billed: "30", cents: 150 }, extra_operator_seat_proration: { billed: "31", cents: 3900 },
    ...over,
  }
  const components = SETTLEMENT_COMPONENTS.map((component) => ({
    component, included_quantity: null, recognized_quantity: null, billed_quantity: base[component].billed, charge_cents: base[component].cents,
  })).sort((a, b) => (a.component < b.component ? -1 : 1))
  const seat = base.extra_operator_seat_proration.cents
  const usage = Object.entries(base).filter(([k]) => k !== "extra_operator_seat_proration").reduce((s, [, v]) => s + v.cents, 0)
  return {
    document_version: "settlement.v1", state: "ok", catalog_version: "2026-11-03.v1", plan_key: "founder-pilot", currency: "usd",
    window_start: "2026-08-01T00:00:00.000Z", window_end: "2026-09-01T00:00:00.000Z",
    base_cents: 19_900, seat_cents: seat, usage_cents: usage, usage_cap_cents: 10_000, total_cents: 19_900 + seat + usage, components, ...tweak,
  }
}

describe("invoice reconstruction from the settled document", () => {
  it("reproduces the settled total exactly from meter values x metered unit prices", () => {
    const d = doc()
    const rebuilt = reconstructInvoiceFromDocument(d)
    expect(rebuilt.eventValues).toMatchObject({ standard_digital_outcome: "5", inbound_voice_agent_minute: "420", sms_segment: "150", extra_operator_seat_proration: "3900" })
    expect(rebuilt.totalCents).toBe(d.total_cents)
    expect(authorizeInvoiceReconstruction(d, rebuilt)).toEqual({ ok: true })
  })
  it("refuses a document whose outcome charge is not billed quantity x approved rate", () => {
    const d = doc({ qualified_lead: { billed: "2", cents: 900 } })
    expect(authorizeInvoiceReconstruction(d, reconstructInvoiceFromDocument(d))).toEqual({ ok: false, code: "invoice_total_mismatch" })
  })
  it("refuses usage above the cap and a fractional outcome quantity", () => {
    const d = doc({}, { usage_cap_cents: 1_000 })
    expect(authorizeInvoiceReconstruction(d, reconstructInvoiceFromDocument(d))).toEqual({ ok: false, code: "usage_exceeds_cap" })
    expect(() => reconstructInvoiceFromDocument(doc({ standard_digital_outcome: { billed: "2.5", cents: 250 } }))).toThrow(/Fractional/)
  })
  it("refuses a base amount other than the approved base", () => {
    const d = doc({}, { base_cents: 14_900, total_cents: 14_900 + 3900 + 2070 })
    expect(authorizeInvoiceReconstruction(d, reconstructInvoiceFromDocument(d))).toEqual({ ok: false, code: "base_mismatch" })
  })
})
