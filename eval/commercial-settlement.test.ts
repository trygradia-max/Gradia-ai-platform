import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  APPROVED_COMMERCIAL_CATALOG_VERSION,
  FOUNDER_APPROVED_COMMERCIAL_CATALOG,
  FOUNDER_PILOT_POLICY,
} from "@/lib/approved-commercial-catalog"
import {
  REVIEWED_SETTLEMENT_METER_MAPPING,
  REVIEWED_VALUE_BASIS,
  SETTLEMENT_COMPONENTS,
  buildDeliveryPlan,
  buildSettlementDocument,
  canonicalJson,
  deriveDeliveryState,
  evaluateEligibility,
  providerIdentifier,
  settlementIdempotencyKey,
  validateMeterMapping,
  validateSettlementWindow,
  verifyMeterAck,
  type MeterMapping,
} from "@/lib/commercial-settlement"
import { classifyProviderFailure, createSettlementProvider } from "@/lib/commercial-settlement-provider"
import { resolveSettlementRuntime, settleCommercialPeriod } from "@/lib/commercial-settlement-service"
import type { MembershipEvidence, MembershipEvidenceEvent } from "@/lib/commercial-seat-proration"
import { previewCommercialPeriod, type EvidenceFact, type PreviewInput } from "@/lib/commercial-usage-preview"
import { StripeError } from "@/lib/stripe"

const START = "2026-11-01T00:00:00.000Z"
const END = "2026-12-01T00:00:00.000Z"
const BEFORE = "2026-09-01T00:00:00Z"
const SHOP = "11111111-1111-4111-8111-111111111111"
let n = 0
const fid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`

const fact = (metric: string, extra: Partial<EvidenceFact> = {}): EvidenceFact => ({
  id: fid(),
  catalogVersion: APPROVED_COMMERCIAL_CATALOG_VERSION,
  metric,
  quantity: "1",
  workflowKey: `wf-${n}`,
  wholesaleUnitCostCents: null,
  wholesaleBasis: null,
  recognizedAt: "2026-11-05T12:00:00Z",
  recordedAt: "2026-11-05T12:00:00Z",
  ...extra,
})
const outcomes = (metric: string, count: number) => Array.from({ length: count }, () => fact(metric))
let seq = 0
const member = (userId: string, at: string): MembershipEvidenceEvent => ({
  id: `m-${++seq}`, shopSeq: seq, userId, kind: "change", newBillable: true, effectiveAt: at, recordedAt: at,
})
const covered = (extra = 0, coveredFrom = BEFORE): MembershipEvidence => ({
  status: "evidence",
  coverage: { coveredFrom, basis: "migration_snapshot", recordedAt: BEFORE },
  events: [member("o", BEFORE), member("m", BEFORE), member("s", BEFORE), ...Array.from({ length: extra }, (_, i) => member(`x${i}`, BEFORE))],
})
const preview = (facts: EvidenceFact[], extra: Partial<PreviewInput> = {}) =>
  previewCommercialPeriod({
    catalog: FOUNDER_APPROVED_COMMERCIAL_CATALOG,
    planKey: FOUNDER_PILOT_POLICY.planKey,
    windowStart: START,
    windowEnd: END,
    asOf: "2027-01-01T00:00:00Z",
    facts,
    corrections: [],
    priorWorkflowMetrics: {},
    membership: covered(1),
    ...extra,
  })

/** A TEST-ONLY provisioned mapping. These names are fixtures; no real meter exists. */
const TEST_MAPPING: MeterMapping = {
  version: "settlement-mapping.test-fixture",
  status: "provisioned",
  entries: SETTLEMENT_COMPONENTS.map((component) => ({
    component,
    valueBasis: REVIEWED_VALUE_BASIS[component],
    eventName: `test_fixture_${component}`,
  })),
}

describe("reviewed meter mapping", () => {
  it("ships unprovisioned: every name is null and nothing can be planned or sent", () => {
    expect(REVIEWED_SETTLEMENT_METER_MAPPING.status).toBe("unprovisioned")
    expect(REVIEWED_SETTLEMENT_METER_MAPPING.entries.map((e) => e.eventName)).toEqual(Array(6).fill(null))
    expect(validateMeterMapping(REVIEWED_SETTLEMENT_METER_MAPPING)).toEqual({ ok: false, reason: "settlement_mapping_unprovisioned" })
  })

  it("covers exactly the five approved metrics plus seat proration, and no other component", () => {
    expect([...SETTLEMENT_COMPONENTS].sort()).toEqual([
      "confirmed_appointment", "extra_operator_seat_proration", "inbound_voice_agent_minute",
      "qualified_lead", "sms_segment", "standard_digital_outcome",
    ])
  })

  it("accepts a fully provisioned mapping and rejects every malformed one", () => {
    expect(validateMeterMapping(TEST_MAPPING).ok).toBe(true)
    const bad = (mutate: (m: { -readonly [K in keyof MeterMapping]: MeterMapping[K] }) => void) => {
      const copy = { ...TEST_MAPPING, entries: TEST_MAPPING.entries.map((e) => ({ ...e })) }
      mutate(copy)
      return validateMeterMapping(copy)
    }
    expect(bad((m) => { m.entries = m.entries.slice(1) })).toEqual({ ok: false, reason: "settlement_mapping_invalid" })
    expect(bad((m) => { m.entries = [...m.entries.slice(0, 5), { ...m.entries[0] }] })).toEqual({ ok: false, reason: "settlement_mapping_invalid" })
    expect(bad((m) => { (m.entries as { eventName: string | null }[])[0].eventName = null })).toEqual({ ok: false, reason: "settlement_mapping_invalid" })
    expect(bad((m) => { (m.entries as { eventName: string | null }[])[0].eventName = "Bad Name!" })).toEqual({ ok: false, reason: "settlement_mapping_invalid" })
    expect(bad((m) => { (m.entries as { eventName: string | null }[])[1].eventName = (m.entries as { eventName: string | null }[])[0].eventName })).toEqual({ ok: false, reason: "settlement_mapping_invalid" })
    // A mapping may supply names only: it cannot change the reviewed value basis.
    expect(bad((m) => { (m.entries as { valueBasis: string }[])[3].valueBasis = "billed_quantity" })).toEqual({ ok: false, reason: "settlement_mapping_invalid" })
    expect(bad((m) => { m.version = "settlement-mapping.v1-unprovisioned" })).toEqual({ ok: false, reason: "settlement_mapping_invalid" })
  })
})

describe("settlement window", () => {
  const NOW = Date.parse("2027-01-01T00:00:00Z")
  it("accepts only an exact, closed, UTC-midnight, month-length window", () => {
    expect(validateSettlementWindow(START, END, NOW)).toEqual([])
    expect(validateSettlementWindow("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", NOW)).toEqual([])
    expect(validateSettlementWindow("2026-11-01T00:00:00Z", "2026-12-01T00:00:00+00:00", NOW)).toEqual([])
  })
  it("refuses open, partial, misaligned, wrong-length and non-UTC windows", () => {
    expect(validateSettlementWindow(START, END, Date.parse("2026-11-20T00:00:00Z"))).toEqual(["window_not_closed"])
    expect(validateSettlementWindow("2026-11-01T01:00:00Z", "2026-12-01T01:00:00Z", NOW)).toContain("window_not_utc_day_aligned")
    expect(validateSettlementWindow("2026-11-01T00:00:00Z", "2026-11-15T00:00:00Z", NOW)).toContain("window_not_billing_month")
    expect(validateSettlementWindow("2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z", NOW)).toContain("window_not_billing_month")
    expect(validateSettlementWindow("2026-11-01T00:00:00+05:00", END, NOW)).toEqual(["window_not_utc_instant"])
    expect(validateSettlementWindow("2026-11-01", END, NOW)).toEqual(["window_not_utc_instant"])
  })
  it("maps database eligibility facts to exact blocks", () => {
    const ok = {
      window_closed: true, utc_day_aligned: true, window_days: 30, account_present: true,
      catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION, plan_key: "founder-pilot",
      has_platform_customer: true, overlapping_settlement_id: null,
    }
    expect(evaluateEligibility(ok)).toEqual([])
    expect(evaluateEligibility({ ...ok, account_present: false, catalog_version: null, plan_key: null, has_platform_customer: false })).toEqual(["no_billing_account"])
    expect(evaluateEligibility({ ...ok, has_platform_customer: false })).toEqual(["no_platform_customer"])
    expect(evaluateEligibility({ ...ok, catalog_version: "old" })).toEqual(["catalog_mismatch"])
    expect(evaluateEligibility({ ...ok, window_closed: false })).toEqual(["window_not_closed"])
    expect(evaluateEligibility({ ...ok, overlapping_settlement_id: SHOP })).toEqual(["overlapping_settlement"])
  })
})

describe("settlement document", () => {
  it("freezes an ok preview exactly: totals, the six components and a stable digest", () => {
    const facts = [...outcomes("standard_digital_outcome", 105), ...outcomes("qualified_lead", 2), ...outcomes("confirmed_appointment", 1)]
    const result = buildSettlementDocument(preview(facts))
    if (!result.ok) throw new Error(JSON.stringify(result))
    const d = result.document
    expect(d.components.map((c) => c.component)).toEqual([...SETTLEMENT_COMPONENTS].sort())
    const by = Object.fromEntries(d.components.map((c) => [c.component, c]))
    // 105 standard outcomes - 100 included = 5 x $1.00; 2 leads x $5; 1 appointment x $10.
    expect(by.standard_digital_outcome).toMatchObject({ billed_quantity: "5", charge_cents: 500, included_quantity: "100", recognized_quantity: "105" })
    expect(by.qualified_lead).toMatchObject({ billed_quantity: "2", charge_cents: 1000 })
    expect(by.confirmed_appointment).toMatchObject({ billed_quantity: "1", charge_cents: 1000 })
    expect(by.extra_operator_seat_proration).toMatchObject({ billed_quantity: "30", charge_cents: 3900, included_quantity: null })
    expect(d.usage_cents).toBe(2500)
    expect(d.seat_cents).toBe(3900)
    expect(d.base_cents).toBe(19_900)
    expect(d.total_cents).toBe(19_900 + 3900 + 2500)
    expect(d.usage_cap_cents).toBe(FOUNDER_PILOT_POLICY.defaultMonthlyOverageCapCents)
    // The same evidence in a different order, and at a different as-of, settles to the same digest.
    const again = buildSettlementDocument(preview([...facts].reverse(), { asOf: "2027-06-01T00:00:00Z" }))
    expect(again.ok && again.digest).toBe(result.digest)
    // A different fact changes it.
    const changed = buildSettlementDocument(preview([...facts, fact("qualified_lead")]))
    expect(changed.ok && changed.digest).not.toBe(result.digest)
  })

  it("uses highest-value-only: one workflow with three outcomes charges only the appointment", () => {
    const wf = "wf-shared"
    const result = buildSettlementDocument(preview([
      fact("standard_digital_outcome", { workflowKey: wf }),
      fact("qualified_lead", { workflowKey: wf }),
      fact("confirmed_appointment", { workflowKey: wf }),
    ]))
    if (!result.ok) throw new Error(JSON.stringify(result))
    const by = Object.fromEntries(result.document.components.map((c) => [c.component, c]))
    expect(by.confirmed_appointment.charge_cents).toBe(1000)
    expect(by.qualified_lead.billed_quantity).toBe("0")
    expect(by.standard_digital_outcome.billed_quantity).toBe("0")
  })

  it("keeps the dynamic markup floors: SMS at cost x3 above the $0.05 floor", () => {
    const result = buildSettlementDocument(preview([fact("sms_segment", { workflowKey: null, quantity: "100", wholesaleUnitCostCents: "3", wholesaleBasis: "provider_reported" })]))
    if (!result.ok) throw new Error(JSON.stringify(result))
    const sms = result.document.components.find((c) => c.component === "sms_segment")!
    expect(sms.charge_cents).toBe(900) // 100 segments x max(5c, 3c x 3 = 9c)
  })

  it.each([
    ["missing wholesale evidence", () => preview([fact("sms_segment", { workflowKey: null, quantity: "1" })]), "preview_unavailable"],
    ["incomplete membership evidence", () => preview([], { membership: covered(0, "2026-11-10T00:00:00Z") }), "seat_proration_unavailable"],
    ["no membership evidence at all", () => preview([], { membership: undefined }), "seat_proration_unavailable"],
    ["a period that is not yet closed", () => preview([], { asOf: "2026-11-20T00:00:00Z" }), "seat_proration_unavailable"],
    ["the one combined cap exceeded", () => preview(outcomes("confirmed_appointment", 11)), "usage_cap_exceeded"],
    ["an over-correction conflict", () => {
      const f = fact("qualified_lead")
      return preview([f], { corrections: [{ id: fid(), recognitionId: f.id, quantity: "2", reason: "duplicate", recordedAt: "2026-11-06T00:00:00Z" }] })
    }, "preview_conflict"],
    ["a malformed fact", () => preview([fact("standard_digital_outcome", { quantity: "2" })]), "preview_invalid"],
    ["an unapproved legacy metric", () => preview([fact("voice_minute")]), "preview_invalid"],
  ])("refuses %s with the exact block and no document", (_name, make, block) => {
    const result = buildSettlementDocument(make())
    expect(result).toMatchObject({ ok: false, block })
    expect(result).not.toHaveProperty("document")
  })

  it("does not settle human-completed, draft, failed or unknown outcomes (they never enter the ledger)", () => {
    // Recognition refuses them (PR A, CB422), so the preview only ever sees confirmed facts;
    // an empty ledger settles to zero usage plus the base and seats, never to a charge.
    const result = buildSettlementDocument(preview([]))
    if (!result.ok) throw new Error(JSON.stringify(result))
    expect(result.document.usage_cents).toBe(0)
    expect(result.document.components.filter((c) => c.component !== "extra_operator_seat_proration").every((c) => c.charge_cents === 0)).toBe(true)
  })
})

describe("delivery plan", () => {
  const document = (facts: EvidenceFact[]) => {
    const built = buildSettlementDocument(preview(facts))
    if (!built.ok) throw new Error(JSON.stringify(built))
    return built.document
  }

  it("plans nothing from the shipped unprovisioned mapping", () => {
    const plan = buildDeliveryPlan({ shopId: SHOP, document: document(outcomes("qualified_lead", 2)), mapping: REVIEWED_SETTLEMENT_METER_MAPPING })
    expect(plan).toEqual({ ok: true, deliveries: [] })
  })

  it("derives every value from the document, never from input; zero lines are not delivered", () => {
    const d = document([...outcomes("standard_digital_outcome", 103), ...outcomes("qualified_lead", 2)])
    const plan = buildDeliveryPlan({ shopId: SHOP, document: d, mapping: TEST_MAPPING })
    if (!plan.ok) throw new Error(JSON.stringify(plan))
    const by = Object.fromEntries(plan.deliveries.map((x) => [x.component, x]))
    expect(Object.keys(by).sort()).toEqual(["extra_operator_seat_proration", "qualified_lead", "standard_digital_outcome"])
    expect(by.standard_digital_outcome).toMatchObject({ value_basis: "billed_quantity", event_value: "3", event_name: "test_fixture_standard_digital_outcome" })
    expect(by.qualified_lead).toMatchObject({ value_basis: "billed_quantity", event_value: "2" })
    expect(by.extra_operator_seat_proration).toMatchObject({ value_basis: "charge_cents", event_value: "3900" })
    expect(plan.deliveries.every((x) => x.event_timestamp === "2026-11-30T23:59:59.000Z")).toBe(true)
  })

  it("refuses a fractional quantity instead of rounding it", () => {
    const d = document([])
    const tampered = { ...d, components: d.components.map((c) => (c.component === "qualified_lead" ? { ...c, billed_quantity: "1.5", charge_cents: 750 } : c)) }
    expect(buildDeliveryPlan({ shopId: SHOP, document: tampered, mapping: TEST_MAPPING })).toEqual({
      ok: false, block: "fractional_quantity_unsupported", component: "qualified_lead",
    })
  })

  it("has stable identities that differ per tenant, window and component", () => {
    const a = providerIdentifier(SHOP, START, END, "qualified_lead")
    expect(a).toBe(providerIdentifier(SHOP, START, END, "qualified_lead"))
    expect(a).toMatch(/^gradia-cb-settle-[0-9a-f]{40}$/)
    expect(a).not.toBe(providerIdentifier(SHOP, START, END, "sms_segment"))
    expect(a).not.toBe(providerIdentifier("22222222-2222-4222-8222-222222222222", START, END, "qualified_lead"))
    expect(a).not.toBe(providerIdentifier(SHOP, START, "2026-12-02T00:00:00Z", "qualified_lead"))
    // Equivalent spellings of the same instant are the same identity.
    expect(settlementIdempotencyKey(SHOP, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00+00:00")).toBe(settlementIdempotencyKey(SHOP, START, END))
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}')
  })
})

describe("provider acknowledgement and failure classification", () => {
  const expected = { eventName: "test_fixture_qualified_lead", customerId: "cus_Test1234", value: "2", identifier: "gradia-cb-settle-" + "a".repeat(40) }
  const ack = (over: Record<string, unknown> = {}) => ({
    object: "billing.meter_event", livemode: false, identifier: expected.identifier, event_name: expected.eventName,
    payload: { stripe_customer_id: expected.customerId, value: "2" }, ...over,
  })
  it("accepts only the exact event we sent", () => {
    expect(verifyMeterAck(ack(), expected)).toEqual({ ok: true })
    expect(verifyMeterAck(ack({ identifier: "other" }), expected)).toEqual({ ok: false, code: "response_mismatch" })
    expect(verifyMeterAck(ack({ event_name: "other" }), expected)).toEqual({ ok: false, code: "response_mismatch" })
    expect(verifyMeterAck(ack({ payload: { stripe_customer_id: "cus_Other1", value: "2" } }), expected)).toEqual({ ok: false, code: "response_mismatch" })
    expect(verifyMeterAck(ack({ payload: { stripe_customer_id: expected.customerId, value: "3" } }), expected)).toEqual({ ok: false, code: "response_mismatch" })
  })
  it("refuses a live object and an unreadable reply", () => {
    expect(verifyMeterAck(ack({ livemode: true }), expected)).toEqual({ ok: false, code: "live_object_refused" })
    expect(verifyMeterAck(ack({ livemode: undefined }), expected)).toEqual({ ok: false, code: "unreadable_response" })
    expect(verifyMeterAck(null, expected)).toEqual({ ok: false, code: "unreadable_response" })
    expect(verifyMeterAck({ object: "customer" }, expected)).toEqual({ ok: false, code: "unreadable_response" })
  })
  it("treats only a 4xx as a definitive rejection; everything else is unknown", () => {
    for (const status of [400, 401, 402, 403, 404]) expect(classifyProviderFailure(new StripeError(status, "x"))).toEqual({ outcome: "rejected", code: "provider_rejected" })
    for (const status of [0, 409, 429, 500, 502, 503]) expect(classifyProviderFailure(new StripeError(status, "x")).outcome).toBe("unknown")
    expect(classifyProviderFailure(new Error("socket hang up")).outcome).toBe("unknown")
  })
  it("derives provider progress that is never 'paid'", () => {
    expect(deriveDeliveryState([])).toBe("no_delivery_required")
    expect(deriveDeliveryState(["not_required", "not_required"])).toBe("no_delivery_required")
    expect(deriveDeliveryState(["pending", "delivered"])).toBe("pending")
    expect(deriveDeliveryState(["in_flight", "delivered"])).toBe("in_flight")
    expect(deriveDeliveryState(["delivered", "not_required"])).toBe("provider_accepted")
    expect(deriveDeliveryState(["delivered", "unknown"])).toBe("reconciliation_required")
    expect(deriveDeliveryState(["pending", "rejected"])).toBe("reconciliation_required")
  })
})

describe("runtime resolution and the real provider (network blocked)", () => {
  it("is disabled when sandbox config is absent, live-shaped, or the mapping is unprovisioned", () => {
    expect(resolveSettlementRuntime({}, TEST_MAPPING)).toEqual({ ok: false, reason: "billing_unconfigured" })
    expect(resolveSettlementRuntime({ GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_live_abcdefghijkl" }, TEST_MAPPING)).toEqual({ ok: false, reason: "billing_misconfigured" })
    expect(resolveSettlementRuntime({ GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "live", STRIPE_SECRET_KEY: "sk_test_abcdefghijkl" }, TEST_MAPPING)).toEqual({ ok: false, reason: "billing_misconfigured" })
    // Sandbox config alone is not enough: the shipped mapping is unprovisioned.
    expect(resolveSettlementRuntime({ GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_test_abcdefghijkl" })).toEqual({ ok: false, reason: "settlement_mapping_unprovisioned" })
    expect(resolveSettlementRuntime({ GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_test_abcdefghijkl" }, TEST_MAPPING).ok).toBe(true)
  })

  it("sends a platform-only, form-encoded meter event with the identifier as idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ object: "billing.meter_event" }), { status: 200 })
    }))
    try {
      const provider = createSettlementProvider({ secretKey: "sk_test_abcdefghijkl", apiBase: "http://127.0.0.1:1/v1", timeoutMs: 1000 })
      await provider.submitMeterEvent({ eventName: "test_fixture_x", customerId: "cus_Test1234", value: "7", identifier: "gradia-cb-settle-" + "b".repeat(40), timestampSeconds: 1_764_547_199 })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:1/v1/billing/meter_events")
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers["Idempotency-Key"]).toBe("gradia-cb-settle-" + "b".repeat(40))
    expect(headers["Stripe-Account"]).toBeUndefined()
    const body = String(calls[0].init.body)
    expect(body).toContain("event_name=test_fixture_x")
    expect(body).toContain("payload%5Bstripe_customer_id%5D=cus_Test1234")
    expect(body).toContain("payload%5Bvalue%5D=7")
  })
})

describe("settleCommercialPeriod fails closed before touching the database", () => {
  const untouchable = new Proxy({}, { get() { throw new Error("database must not be touched") } }) as unknown as SupabaseClient
  const input = { shopId: SHOP, actorId: "33333333-3333-4333-8333-333333333333", windowStart: START, windowEnd: END }
  it("refuses an unprovisioned runtime", async () => {
    const runtime = resolveSettlementRuntime({}, REVIEWED_SETTLEMENT_METER_MAPPING)
    expect(await settleCommercialPeriod(untouchable, runtime, input)).toMatchObject({ ok: false, reason: "runtime_unavailable" })
  })
  it("refuses malformed input, including model-style extra fields", async () => {
    const runtime = { ok: true as const, provider: { submitMeterEvent: vi.fn() }, mapping: TEST_MAPPING }
    expect(await settleCommercialPeriod(untouchable, runtime, { ...input, shopId: "nope" })).toMatchObject({ ok: false, reason: "invalid" })
    expect(await settleCommercialPeriod(untouchable, runtime, { ...input, metric: "sms_segment", quantity: "9" } as never)).toMatchObject({ ok: false, reason: "invalid" })
    expect(runtime.provider.submitMeterEvent).not.toHaveBeenCalled()
  })
})
