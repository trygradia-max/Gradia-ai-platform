import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import {
  REVIEWED_SETTLEMENT_METER_MAPPING,
  REVIEWED_VALUE_BASIS,
  SETTLEMENT_COMPONENTS,
  providerIdentifier,
  settlementIdempotencyKey,
  type MeterMapping,
} from "@/lib/commercial-settlement"
import {
  deliverCommercialSettlement,
  previewCommercialSettlement,
  readCommercialSettlement,
  settleCommercialPeriod,
  type SettlementRuntime,
} from "@/lib/commercial-settlement-service"
import type { SettlementMeterEvent, SettlementProvider } from "@/lib/commercial-settlement-provider"
import { recognizeCommercialUsage } from "@/lib/commercial-usage-service"
import { StripeError } from "@/lib/stripe"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  assertDisposableTarget,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PW = "Synthetic-password-123!"
// A fully past, month-length window. Coverage is backdated to before it (see `fixture`).
const W = { windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-09-01T00:00:00.000Z" }
const BACKDATE = "2026-07-01T00:00:00Z"
const AT = (day: number) => `2026-08-${String(day).padStart(2, "0")}T12:00:00Z`

/** A TEST-ONLY provisioned mapping: the names are fixtures, no real meter exists. */
const TEST_MAPPING: MeterMapping = {
  version: "settlement-mapping.int-fixture",
  status: "provisioned",
  entries: SETTLEMENT_COMPONENTS.map((component) => ({
    component,
    valueBasis: REVIEWED_VALUE_BASIS[component],
    eventName: `int_fixture_${component}`,
  })),
}

let db: SupabaseClient
const seeded: Seeded[] = []
let seq = 0
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`

async function transient<T>(fn: () => Promise<T>): Promise<T> {
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
async function newUser(password = false): Promise<Seeded> {
  const s = await transient(() => seedShop(db, password ? { password: PW } : undefined))
  seeded.push(s)
  return s
}

/**
 * Fixture-only SQL through the local stack's pg-meta endpoint (the disposable target is asserted).
 * It is used for exactly two things the application can never do: backdating coverage so a past
 * window can be covered, and proving the immutability triggers hold for the table owner.
 */
async function sql(query: string): Promise<{ ok: boolean; rows: unknown; message?: string }> {
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

type Fixture = {
  shop: Seeded
  owner: SupabaseClient
  /** Extra billable operators besides the owner (all backdated with the shop). */
  extra: Seeded[]
  customerId: string
}
async function fixture(opts: { covered?: boolean; customer?: boolean | "account_only"; extraOperators?: number } = {}): Promise<Fixture> {
  const { covered = true, customer = true, extraOperators = 3 } = opts
  const shop = await newUser(true)
  const extra: Seeded[] = []
  for (let i = 0; i < extraOperators; i++) {
    const u = await newUser()
    extra.push(u)
    const r = await db
      .from("shop_memberships")
      .upsert({ shop_id: shop.shopId, user_id: u.ownerId, role: i % 2 ? "staff" : "manager", capabilities: [], active: true, display_name: `m${i}` }, { onConflict: "shop_id,user_id" })
    expect(r.error).toBeNull()
  }
  if (covered) {
    const r = await sql(`
      ALTER TABLE public.commercial_membership_events DISABLE TRIGGER commercial_membership_events_append_only;
      ALTER TABLE public.commercial_membership_coverage DISABLE TRIGGER commercial_membership_coverage_append_only;
      UPDATE public.commercial_membership_events SET effective_at='${BACKDATE}', recorded_at='${BACKDATE}' WHERE shop_id='${shop.shopId}';
      UPDATE public.commercial_membership_coverage SET covered_from='${BACKDATE}', recorded_at='${BACKDATE}' WHERE shop_id='${shop.shopId}';
      ALTER TABLE public.commercial_membership_events ENABLE TRIGGER commercial_membership_events_append_only;
      ALTER TABLE public.commercial_membership_coverage ENABLE TRIGGER commercial_membership_coverage_append_only;`)
    expect(r.ok, r.message).toBe(true)
  }
  const customerId = `cus_IntFixture${uniq().replace(/[^A-Za-z0-9]/g, "")}`
  if (customer) {
    const begun = await db.rpc("commercial_checkout_begin", {
      p_shop: shop.shopId, p_actor: shop.ownerId, p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
      p_plan_key: "founder-pilot", p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents",
      p_fingerprint: "c".repeat(64),
    })
    expect(begun.error).toBeNull()
    if (customer === true) {
      const bound = await db.rpc("commercial_checkout_bind_customer", {
        p_shop: shop.shopId, p_actor: shop.ownerId, p_attempt: (begun.data as { attempt_id: string }).attempt_id, p_customer: customerId,
      })
      expect(bound.error).toBeNull()
      // PR E1: a settlement window must equal a VERIFIED Stripe subscription period. Seed one
      // through the single evidence writer (reviewed source), starting at the subscription's start.
      const evidence = await db.rpc("commercial_subscription_apply_evidence", {
        p_shop: shop.shopId, p_subscription: `sub_IntFix${uniq().replace(/[^A-Za-z0-9]/g, "")}`, p_customer: customerId,
        p_status: "active", p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot",
        p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_source: "reviewed_reconciliation",
        p_event_id: `evt_intfix_${uniq()}`, p_event_created_at: W.windowStart, p_livemode: false,
        p_period_start: W.windowStart, p_period_end: W.windowEnd, p_started_at: W.windowStart,
      })
      expect(evidence.error).toBeNull()
    }
  }
  return { shop, owner: await ownerSessionClient(shop.email, PW), extra, customerId }
}

const outcomeInput = (shopId: string, metric: string, workflowKey: string, day = 10) => ({
  kind: "outcome" as const, shopId, metric: metric as "confirmed_appointment", workflowKey, sourceRef: `wf:${workflowKey}`,
  outcome: { state: "confirmed", humanCompleted: false }, recognizedAt: AT(day),
})
async function recognizeOutcomes(shopId: string, metric: string, count: number, tag = uniq()) {
  for (let i = 0; i < count; i++) {
    const r = await recognizeCommercialUsage(db, outcomeInput(shopId, metric, `${tag}-${metric}-${i}`))
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }
}
async function recognizeSms(shopId: string, quantity: number, cost: string | null) {
  const ev = await db.from("usage_events").insert({ shop_id: shopId, kind: "sms_segment", quantity, credits: 0, vendor_ref: `int-${uniq()}`, ref_id: `ref-${uniq()}` }).select("id").single()
  expect(ev.error).toBeNull()
  const r = await recognizeCommercialUsage(db, {
    kind: "provider_usage", shopId, metric: "sms_segment", usageEventId: ev.data!.id as string, sourceRef: `provider:${ev.data!.id}`,
    quantity: String(quantity), direction: "outbound", recognizedAt: AT(12),
    ...(cost === null ? {} : { wholesale: { unitCostCents: cost, basis: "provider_reported" as const } }),
  })
  expect(r.ok, JSON.stringify(r)).toBe(true)
}

// ---------- fake provider: behaves like a meter-event endpoint keyed by identifier ----------
type FakeOpts = {
  failWith?: (event: SettlementMeterEvent) => Error | null
  ack?: (event: SettlementMeterEvent) => unknown
  delayMs?: number
}
function fakeProvider(opts: FakeOpts = {}) {
  const received: SettlementMeterEvent[] = []
  const seen = new Set<string>()
  const provider: SettlementProvider = {
    async submitMeterEvent(event) {
      received.push(event)
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const failure = opts.failWith?.(event)
      if (failure) throw failure
      seen.add(event.identifier)
      return opts.ack
        ? opts.ack(event)
        : {
            object: "billing.meter_event", livemode: false, identifier: event.identifier, event_name: event.eventName,
            payload: { stripe_customer_id: event.customerId, value: event.value },
          }
    },
  }
  const runtime: SettlementRuntime = { ok: true, provider, mapping: TEST_MAPPING }
  return { provider, runtime, received, seen }
}

const settle = (f: Fixture, runtime: SettlementRuntime, window = W) =>
  settleCommercialPeriod(db, runtime, { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...window })

async function rows<T = Record<string, unknown>>(table: string, shopId: string, order = "id"): Promise<T[]> {
  const r = await db.from(table).select("*").eq("shop_id", shopId).order(order)
  expect(r.error).toBeNull()
  return r.data as T[]
}
const accountSnapshot = async (shopId: string) => {
  const a = await db.from("commercial_billing_accounts").select("*").eq("shop_id", shopId).single()
  const e = await db.from("commercial_subscription_evidence").select("id").eq("shop_id", shopId)
  const att = await db.from("commercial_checkout_attempts").select("id,status").eq("shop_id", shopId)
  return JSON.stringify({ a: a.data, e: e.data, att: att.data })
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("commercial settlement", () => {
  let base: Fixture
  let stranger: Fixture

  beforeAll(async () => {
    db = serviceClient()
    base = await fixture()
    stranger = await fixture({ extraOperators: 0 })
  }, 120_000)

  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s).catch(() => undefined)
  }, 120_000)

  /** The pre-F2 shape (every name null): still fails closed. */
const UNPROVISIONED_MAPPING: MeterMapping = {
  version: "settlement-mapping.v1-unprovisioned",
  status: "unprovisioned",
  entries: SETTLEMENT_COMPONENTS.map((component) => ({ component, valueBasis: REVIEWED_VALUE_BASIS[component], eventName: null })),
}

describe("preview", () => {
    it("shows the exact settlement an owner would get and blocks delivery while the mapping is unprovisioned", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "confirmed_appointment", 2)
      await recognizeOutcomes(f.shop.shopId, "standard_digital_outcome", 101)
      const preview = await previewCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...W, mapping: UNPROVISIONED_MAPPING })
      if (preview.status !== "ready") throw new Error(JSON.stringify(preview))
      const by = Object.fromEntries(preview.document.components.map((c) => [c.component, c]))
      expect(by.confirmed_appointment).toMatchObject({ billed_quantity: "2", charge_cents: 2000 })
      expect(by.standard_digital_outcome).toMatchObject({ billed_quantity: "1", charge_cents: 100, recognized_quantity: "101" })
      // owner + 3 extra operators = 4 billable => 1 extra seat-day x 31 days x $39 / 31 days = $39.
      expect(by.extra_operator_seat_proration).toMatchObject({ billed_quantity: "31", charge_cents: 3900 })
      expect(preview.document.total_cents).toBe(19_900 + 3900 + 2100)
      expect(preview.alreadySettled).toBe(false)
      expect(preview.delivery).toEqual({ state: "blocked", reason: "settlement_mapping_unprovisioned" })
      const withMapping = await previewCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...W, mapping: TEST_MAPPING })
      if (withMapping.status !== "ready" || withMapping.delivery.state !== "planned") throw new Error(JSON.stringify(withMapping))
      expect(withMapping.delivery.deliveries.map((d) => d.component).sort()).toEqual(["confirmed_appointment", "extra_operator_seat_proration", "standard_digital_outcome"])
      // A preview writes nothing.
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(0)
    })

    it("blocks an open window and any window that is not an exact verified subscription period, with the exact reason", async () => {
      const month = new Date()
      const open = { windowStart: `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`, windowEnd: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)).toISOString() }
      expect(await previewCommercialSettlement(base.owner, { shopId: base.shop.shopId, ...open })).toMatchObject({ status: "blocked", blocks: expect.arrayContaining(["window_not_closed"]) })
      expect(await previewCommercialSettlement(base.owner, { shopId: base.shop.shopId, windowStart: W.windowStart, windowEnd: "2026-08-15T00:00:00.000Z" })).toMatchObject({ status: "blocked", blocks: ["subscription_period_not_verified"] })
      expect(await previewCommercialSettlement(base.owner, { shopId: base.shop.shopId, windowStart: "2026-08-01T06:00:00.000Z", windowEnd: "2026-09-01T06:00:00.000Z" })).toMatchObject({ status: "blocked", blocks: ["subscription_period_not_verified"] })
      expect(await previewCommercialSettlement(base.owner, { shopId: base.shop.shopId, windowStart: "2026-08-01", windowEnd: "2026-09-01" })).toEqual({ status: "unavailable", reason: "invalid_window" })
    })

    it("blocks incomplete membership coverage rather than reconstructing seats", async () => {
      const f = await fixture({ covered: false })
      expect(await previewCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...W })).toMatchObject({ status: "blocked", blocks: ["seat_proration_unavailable"], detail: expect.stringMatching(/coverage|no_coverage/) })
    })

    it("blocks a missing account, a missing customer, and unknown wholesale evidence", async () => {
      const noAccount = await fixture({ customer: false })
      expect(await previewCommercialSettlement(noAccount.owner, { shopId: noAccount.shop.shopId, ...W })).toMatchObject({ status: "blocked", blocks: ["subscription_period_not_verified", "no_billing_account"] })
      const noCustomer = await fixture({ customer: "account_only" })
      expect(await previewCommercialSettlement(noCustomer.owner, { shopId: noCustomer.shop.shopId, ...W })).toMatchObject({ status: "blocked", blocks: ["subscription_period_not_verified", "no_platform_customer"] })
      const noCost = await fixture()
      await recognizeSms(noCost.shop.shopId, 10, null)
      expect(await previewCommercialSettlement(noCost.owner, { shopId: noCost.shop.shopId, ...W })).toMatchObject({ status: "blocked", blocks: ["preview_unavailable"], detail: "wholesale_evidence_missing" })
    })

    it("refuses when the one combined cap would be exceeded and stores nothing", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "confirmed_appointment", 11)
      expect(await previewCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...W })).toMatchObject({ status: "blocked", blocks: ["usage_cap_exceeded"] })
      const fake = fakeProvider()
      expect(await settle(f, fake.runtime)).toMatchObject({ ok: false, reason: "blocked", blocks: ["usage_cap_exceeded"] })
      expect(fake.received).toHaveLength(0)
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(0)
    })

    it("never bills drafts, failures, unknown outcomes or human-completed work", async () => {
      const f = await fixture()
      for (const [i, outcome] of [
        { state: "draft", humanCompleted: false }, { state: "failure", humanCompleted: false },
        { state: "unknown", humanCompleted: false }, { state: "confirmed", humanCompleted: true },
      ].entries()) {
        const r = await recognizeCommercialUsage(db, { ...outcomeInput(f.shop.shopId, "confirmed_appointment", `bad-${i}`), outcome })
        expect(r).toMatchObject({ ok: false, reason: "not_billable" })
      }
      const preview = await previewCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...W })
      if (preview.status !== "ready") throw new Error(JSON.stringify(preview))
      expect(preview.document.usage_cents).toBe(0)
    })
  })

  describe("settlement and delivery", () => {
    it("settles a closed window once, delivers exactly the ledger's events, and touches no subscription state", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 2)
      await recognizeOutcomes(f.shop.shopId, "standard_digital_outcome", 103)
      await recognizeSms(f.shop.shopId, 100, "3")
      const before = await accountSnapshot(f.shop.shopId)
      const fake = fakeProvider()
      const result = await settle(f, fake.runtime)
      if (!result.ok) throw new Error(JSON.stringify(result))
      expect(result).toMatchObject({ action: "created", delivery: "provider_accepted" })

      const [header] = await rows<Record<string, unknown>>("commercial_settlements", f.shop.shopId)
      expect(header).toMatchObject({
        catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION, plan_key: "founder-pilot", provider_mode: "test",
        base_cents: 19_900, seat_cents: 3900, usage_cents: 1000 + 300 + 900, total_cents: 19_900 + 3900 + 2200,
        mapping_version: TEST_MAPPING.version, stripe_customer_id: f.customerId, requested_by: f.shop.ownerId,
      })
      expect(Date.parse(header.window_start as string)).toBe(Date.parse(W.windowStart))
      expect(Date.parse(header.window_end as string)).toBe(Date.parse(W.windowEnd))
      const lines = await rows<Record<string, unknown>>("commercial_settlement_lines", f.shop.shopId, "component")
      expect(lines.map((l) => l.component)).toEqual([...SETTLEMENT_COMPONENTS].sort())
      const status = Object.fromEntries(lines.map((l) => [l.component, l.delivery_status]))
      expect(status).toEqual({
        confirmed_appointment: "not_required", extra_operator_seat_proration: "delivered", inbound_voice_agent_minute: "not_required",
        qualified_lead: "delivered", sms_segment: "delivered", standard_digital_outcome: "delivered",
      })
      // Exactly the reviewed events, with values derived from the ledger.
      const sent = Object.fromEntries(fake.received.map((e) => [e.eventName, e]))
      expect(Object.keys(sent).sort()).toEqual(["int_fixture_extra_operator_seat_proration", "int_fixture_qualified_lead", "int_fixture_sms_segment", "int_fixture_standard_digital_outcome"])
      expect(sent.int_fixture_qualified_lead).toMatchObject({ customerId: f.customerId, value: "2", timestampSeconds: Date.parse(W.windowEnd) / 1000 - 1 })
      expect(sent.int_fixture_standard_digital_outcome.value).toBe("3")
      expect(sent.int_fixture_sms_segment.value).toBe("900") // charge cents: 100 x max(5c, 9c)
      expect(sent.int_fixture_extra_operator_seat_proration.value).toBe("3900")
      expect(sent.int_fixture_qualified_lead.identifier).toBe(providerIdentifier(f.shop.shopId, W.windowStart, W.windowEnd, "qualified_lead"))
      // Gapless, bounded, URL/key-free evidence.
      const events = await rows<{ shop_seq: number; kind: string }>("commercial_settlement_events", f.shop.shopId, "shop_seq")
      expect(events.map((e) => e.shop_seq)).toEqual(events.map((_, i) => i + 1))
      expect(events.map((e) => e.kind).filter((k) => k === "delivery_delivered")).toHaveLength(4)
      // Settlement never marks anything paid or active and never touches checkout/subscription state.
      expect(await accountSnapshot(f.shop.shopId)).toBe(before)
      // Owner-visible read.
      const read = await readCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...W })
      if (read.status !== "settled") throw new Error(JSON.stringify(read))
      expect(read.delivery).toBe("provider_accepted")
      expect(JSON.stringify(read)).not.toMatch(/cus_|claim_token/)
    })

    it("replays exactly: same settlement, no second provider call, no new rows", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const fake = fakeProvider()
      const first = await settle(f, fake.runtime)
      if (!first.ok) throw new Error(JSON.stringify(first))
      const sentBefore = fake.received.length
      const eventsBefore = (await rows("commercial_settlement_events", f.shop.shopId)).length
      const again = await settle(f, fake.runtime)
      expect(again).toMatchObject({ ok: true, action: "replay", settlementId: first.settlementId, delivery: "provider_accepted" })
      expect(fake.received).toHaveLength(sentBefore)
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(1)
      expect((await rows("commercial_settlement_events", f.shop.shopId)).length).toBe(eventsBefore)
    })

    it("serializes concurrent settlements: one settlement, one provider call per line", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 3)
      const fake = fakeProvider({ delayMs: 25 })
      const results = await Promise.all(Array.from({ length: 8 }, () => settle(f, fake.runtime)))
      for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(new Set(results.map((r) => (r.ok ? r.settlementId : ""))).size).toBe(1)
      expect(results.filter((r) => r.ok && r.action === "created")).toHaveLength(1)
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(1)
      const ids = fake.received.map((e) => e.identifier)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toHaveLength(2) // qualified_lead + seat proration, each sent once
      const lines = await rows<{ delivery_status: string }>("commercial_settlement_lines", f.shop.shopId, "component")
      expect(lines.filter((l) => l.delivery_status === "delivered")).toHaveLength(2)
    })

    it("conflicts on a changed replay: late evidence cannot silently change a settled window", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const fake = fakeProvider()
      const first = await settle(f, fake.runtime)
      if (!first.ok) throw new Error(JSON.stringify(first))
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1, "late")
      const sent = fake.received.length
      const again = await settle(f, fake.runtime)
      expect(again).toMatchObject({ ok: false, reason: "conflict" })
      expect(fake.received).toHaveLength(sent)
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(1)
      // The stored settlement is unchanged.
      const read = await readCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...W })
      expect(read).toMatchObject({ status: "settled", settlement: { id: first.settlementId, usage_cents: 500 } })
    })

    it("refuses a window that overlaps a settled period (it is not an exact verified period)", async () => {
      const f = await fixture()
      const fake = fakeProvider()
      expect((await settle(f, fake.runtime)).ok).toBe(true)
      const overlap = { windowStart: "2026-08-05T00:00:00.000Z", windowEnd: "2026-09-03T00:00:00.000Z" }
      expect(await previewCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...overlap })).toMatchObject({ status: "blocked", blocks: expect.arrayContaining(["subscription_period_not_verified"]) })
      expect(await settle(f, fake.runtime, overlap)).toMatchObject({ ok: false, reason: "blocked" })
    })
  })

  describe("ambiguous, rejected and unverifiable provider results", () => {
    const withLead = async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      return f
    }
    const statusOf = async (f: Fixture) =>
      Object.fromEntries((await rows<{ component: string; delivery_status: string; failure_code: string | null }>("commercial_settlement_lines", f.shop.shopId, "component")).map((l) => [l.component, `${l.delivery_status}:${l.failure_code ?? ""}`]))

    it("records a timeout as unknown, reports reconciliation, and never retries it", async () => {
      const f = await withLead()
      const fake = fakeProvider({ failWith: (e) => (e.eventName.endsWith("qualified_lead") ? new StripeError(0, "timeout", "timeout") : null) })
      const result = await settle(f, fake.runtime)
      if (!result.ok) throw new Error(JSON.stringify(result))
      expect(result.delivery).toBe("reconciliation_required")
      expect(await statusOf(f)).toMatchObject({ qualified_lead: "unknown:provider_outcome_unknown", extra_operator_seat_proration: "delivered:" })
      const calls = fake.received.length
      // A later run, a replay and an explicit deliver all send nothing for the unknown line.
      expect(await settle(f, fake.runtime)).toMatchObject({ ok: true, action: "replay", delivery: "reconciliation_required" })
      const redeliver = await deliverCommercialSettlement(db, fake.runtime, { shopId: f.shop.shopId, settlementId: (result as { settlementId: string }).settlementId })
      expect(redeliver).toMatchObject({ ok: true, delivery: "reconciliation_required" })
      expect(fake.received).toHaveLength(calls)
      expect((await redeliver as { deliveries: { component: string; outcome: string }[] }).deliveries.find((d) => d.component === "qualified_lead")?.outcome).toBe("blocked")
    })

    it.each([409, 429, 500, 503])("treats HTTP %i as ambiguous (unknown), not as a safe failure", async (status) => {
      const f = await withLead()
      const fake = fakeProvider({ failWith: () => new StripeError(status, "x") })
      const result = await settle(f, fake.runtime)
      if (!result.ok) throw new Error(JSON.stringify(result))
      expect(Object.values(await statusOf(f)).every((s) => s === "unknown:provider_outcome_unknown")).toBe(false) // not_required lines stay not_required
      expect((await statusOf(f)).qualified_lead).toBe("unknown:provider_outcome_unknown")
    })

    it("records a definitive 4xx rejection as rejected and does not retry it automatically", async () => {
      const f = await withLead()
      const fake = fakeProvider({ failWith: (e) => (e.eventName.endsWith("qualified_lead") ? new StripeError(400, "bad") : null) })
      const result = await settle(f, fake.runtime)
      if (!result.ok) throw new Error(JSON.stringify(result))
      expect((await statusOf(f)).qualified_lead).toBe("rejected:provider_rejected")
      expect(result.delivery).toBe("reconciliation_required")
      const calls = fake.received.length
      await settle(f, fake.runtime)
      expect(fake.received).toHaveLength(calls)
    })

    it.each([
      ["a live-mode acknowledgement", (e: SettlementMeterEvent) => ({ object: "billing.meter_event", livemode: true, identifier: e.identifier, event_name: e.eventName, payload: { stripe_customer_id: e.customerId, value: e.value } }), "live_object_refused"],
      ["a mismatched identifier", (e: SettlementMeterEvent) => ({ object: "billing.meter_event", livemode: false, identifier: "other-" + e.identifier, event_name: e.eventName, payload: { stripe_customer_id: e.customerId, value: e.value } }), "response_mismatch"],
      ["an unreadable reply", () => ({ nope: true }), "unreadable_response"],
    ])("records %s as unknown", async (_name, ack, code) => {
      const f = await withLead()
      const fake = fakeProvider({ ack })
      const result = await settle(f, fake.runtime)
      if (!result.ok) throw new Error(JSON.stringify(result))
      expect((await statusOf(f)).qualified_lead).toBe(`unknown:${code}`)
    })
  })

  // ---------- direct database boundary: the writers, re-checked by the database ----------
  const canon = (v: string) => new Date(Date.parse(v)).toISOString()
  async function beginArgs(f: Fixture, window = W) {
    const p = await previewCommercialSettlement(f.owner, { shopId: f.shop.shopId, ...window, mapping: TEST_MAPPING })
    if (p.status !== "ready" || p.delivery.state !== "planned") throw new Error(JSON.stringify(p))
    return {
      preview: p,
      args: {
        p_shop: f.shop.shopId, p_actor: f.shop.ownerId, p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
        p_plan_key: "founder-pilot", p_window_start: canon(window.windowStart), p_window_end: canon(window.windowEnd),
        p_as_of: p.asOf, p_evidence_digest: p.evidenceDigest, p_document: p.document, p_document_digest: p.documentDigest,
        p_mapping_version: TEST_MAPPING.version, p_deliveries: p.delivery.deliveries,
        p_idempotency_key: settlementIdempotencyKey(f.shop.shopId, window.windowStart, window.windowEnd),
      } as Record<string, unknown>,
    }
  }
  type Begun = { settlementId: string; lines: Record<string, string>; args: Record<string, unknown> }
  async function beginDirect(f: Fixture): Promise<Begun> {
    const { args } = await beginArgs(f)
    const r = await db.rpc("commercial_settlement_begin", args)
    expect(r.error, JSON.stringify(r.error)).toBeNull()
    const data = r.data as { action: string; settlement_id: string; lines: { line_id: string; component: string }[] }
    expect(data.action).toBe("created")
    return { settlementId: data.settlement_id, lines: Object.fromEntries(data.lines.map((l) => [l.component, l.line_id])), args }
  }
  const claim = (shopId: string, settlementId: string, lineId: string) =>
    db.rpc("commercial_settlement_delivery_claim", { p_shop: shopId, p_settlement: settlementId, p_line: lineId })
  const record = (shopId: string, settlementId: string, lineId: string, token: string, outcome: string, code: string | null = null) =>
    db.rpc("commercial_settlement_delivery_record", { p_shop: shopId, p_settlement: settlementId, p_line: lineId, p_claim_token: token, p_outcome: outcome, p_code: code })

  describe("delivery state machine", () => {
    it("rejects out-of-order attempts: record before claim, wrong token, double record", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const b = await beginDirect(f)
      const line = b.lines.qualified_lead
      const token = "00000000-0000-4000-8000-000000000001"
      expect((await record(f.shop.shopId, b.settlementId, line, token, "delivered")).error?.code).toBe("CB409")
      const claimed = await claim(f.shop.shopId, b.settlementId, line)
      expect(claimed.error).toBeNull()
      const c = claimed.data as { action: string; claim_token: string; event_value: string; stripe_customer_id: string }
      expect(c).toMatchObject({ action: "claimed", event_value: "1", stripe_customer_id: f.customerId })
      // A second worker sees the live claim and must not send.
      expect((await claim(f.shop.shopId, b.settlementId, line)).data).toEqual({ action: "in_progress" })
      expect((await record(f.shop.shopId, b.settlementId, line, token, "delivered")).error?.code).toBe("CB409")
      expect((await record(f.shop.shopId, b.settlementId, line, c.claim_token, "bogus")).error?.code).toBe("22023")
      expect((await record(f.shop.shopId, b.settlementId, line, c.claim_token, "rejected", null)).error?.code).toBe("22023")
      expect((await record(f.shop.shopId, b.settlementId, line, c.claim_token, "delivered")).error).toBeNull()
      expect((await record(f.shop.shopId, b.settlementId, line, c.claim_token, "delivered")).error?.code).toBe("CB409")
      expect((await record(f.shop.shopId, b.settlementId, line, c.claim_token, "unknown", "late_outcome")).error?.code).toBe("CB409")
      expect((await claim(f.shop.shopId, b.settlementId, line)).data).toEqual({ action: "delivered" })
      // A not-required line cannot be claimed into a send.
      expect((await claim(f.shop.shopId, b.settlementId, b.lines.sms_segment)).data).toEqual({ action: "not_required" })
    })

    it("marks a claim abandoned for 120 s as unknown and never hands it out again", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const b = await beginDirect(f)
      const line = b.lines.qualified_lead
      const first = await claim(f.shop.shopId, b.settlementId, line)
      expect((first.data as { action: string }).action).toBe("claimed")
      const aged = await sql(`
        ALTER TABLE public.commercial_settlement_lines DISABLE TRIGGER commercial_settlement_lines_guard;
        UPDATE public.commercial_settlement_lines SET claimed_at = clock_timestamp() - interval '130 seconds' WHERE id='${line}';
        ALTER TABLE public.commercial_settlement_lines ENABLE TRIGGER commercial_settlement_lines_guard;`)
      expect(aged.ok, aged.message).toBe(true)
      expect((await claim(f.shop.shopId, b.settlementId, line)).data).toEqual({ action: "blocked", status: "unknown", failure_code: "stale_in_flight" })
      expect((await claim(f.shop.shopId, b.settlementId, line)).data).toEqual({ action: "blocked", status: "unknown", failure_code: "stale_in_flight" })
      expect((await record(f.shop.shopId, b.settlementId, line, (first.data as { claim_token: string }).claim_token, "delivered")).error?.code).toBe("CB409")
      const events = await rows<{ kind: string }>("commercial_settlement_events", f.shop.shopId, "shop_seq")
      expect(events.map((e) => e.kind)).toContain("delivery_stale_marked_unknown")
      // The service never sends it.
      const fake = fakeProvider()
      const done = await deliverCommercialSettlement(db, fake.runtime, { shopId: f.shop.shopId, settlementId: b.settlementId })
      expect(done).toMatchObject({ ok: true, delivery: "reconciliation_required" })
      expect(fake.received.map((e) => e.eventName)).not.toContain("int_fixture_qualified_lead")
    })

    it("cannot claim or record across tenants", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const b = await beginDirect(f)
      expect((await claim(stranger.shop.shopId, b.settlementId, b.lines.qualified_lead)).error?.code).toBe("CB409")
      const mine = await claim(f.shop.shopId, b.settlementId, b.lines.qualified_lead)
      expect((await record(stranger.shop.shopId, b.settlementId, b.lines.qualified_lead, (mine.data as { claim_token: string }).claim_token, "delivered")).error?.code).toBe("CB409")
    })
  })

  describe("the database rechecks every settlement request", () => {
    const code = async (f: Fixture, patch: Record<string, unknown>) => (await db.rpc("commercial_settlement_begin", { ...(await beginArgs(f)).args, ...patch })).error?.code
    let f: Fixture
    beforeAll(async () => {
      f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
    }, 60_000)

    it("refuses a window that is not closed or not an exact verified subscription period", async () => {
      const now = new Date()
      const futureEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)).toISOString()
      expect(await code(f, { p_window_end: futureEnd, p_as_of: futureEnd })).toBe("CB422") // as_of after now
      expect(await code(f, { p_as_of: "2026-08-31T00:00:00Z" })).toBe("CB422") // evidence instant before the window closed
      expect(await code(f, { p_window_end: "2026-08-15T00:00:00Z" })).toBe("CB422")
      expect(await code(f, { p_window_start: "2026-08-01T06:00:00Z", p_window_end: "2026-09-01T06:00:00Z" })).toBe("CB422")
    })

    it("refuses stale or foreign evidence, unapproved terms and impossible documents", async () => {
      expect(await code(f, { p_evidence_digest: "0".repeat(64) })).toBe("CB409")
      const foreign = (await beginArgs(stranger).catch(() => null))?.args
      if (foreign) expect(await code(f, { p_evidence_digest: foreign.p_evidence_digest })).toBe("CB409")
      expect(await code(f, { p_catalog_version: "2026-01-01.v0" })).toBe("22023")
      expect(await code(f, { p_plan_key: "growth" })).toBe("22023")
      const { args } = await beginArgs(f)
      const doc = args.p_document as { components: { component: string; charge_cents: number }[]; usage_cents: number; total_cents: number }
      expect(await code(f, { p_document: { ...doc, total_cents: doc.total_cents + 1 } })).toBe("22023")
      expect(await code(f, { p_document: { ...doc, usage_cents: 99_999, total_cents: doc.total_cents - doc.usage_cents + 99_999 } })).toBe("22023")
      expect(await code(f, { p_document: { ...doc, state: "cap_exceeded" } })).toBe("22023")
      expect(await code(f, { p_document: { ...doc, components: doc.components.slice(1) } })).toBe("22023")
      expect(await code(f, { p_document: { ...doc, components: [...doc.components.slice(1), { ...doc.components[0], component: "model_invented_metric" }] } })).toBe("22023")
      const deliveries = args.p_deliveries as { component: string; event_value: string }[]
      expect(await code(f, { p_deliveries: deliveries.map((d) => (d.component === "qualified_lead" ? { ...d, event_value: "9" } : d)) })).toBe("22023")
      expect(await code(f, { p_deliveries: deliveries.filter((d) => d.component !== "qualified_lead") })).toBe("22023")
      expect(await code(f, { p_deliveries: [...deliveries, { ...deliveries[0], component: "model_invented_metric" }] })).toBe("22023")
      expect(await code(f, { p_deliveries: [...deliveries, deliveries[0]] })).toBe("22023")
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(0)
    })

    it("refuses missing coverage, a missing account and a missing customer", async () => {
      const uncovered = await fixture({ covered: false })
      const noAccount = await fixture({ customer: false })
      const noCustomer = await fixture({ customer: "account_only" })
      const { args } = await beginArgs(f)
      for (const [name, other] of [["uncovered", uncovered], ["no account", noAccount], ["no customer", noCustomer]] as const) {
        const r = await db.rpc("commercial_settlement_begin", { ...args, p_shop: other.shop.shopId, p_actor: other.shop.ownerId })
        expect(r.error?.code, name).toBe("CB422")
        expect(await rows("commercial_settlements", other.shop.shopId)).toHaveLength(0)
      }
    })

    it("refuses a changed replay of an existing settlement", async () => {
      const g = await fixture()
      await recognizeOutcomes(g.shop.shopId, "qualified_lead", 1)
      const b = await beginDirect(g)
      const same = await db.rpc("commercial_settlement_begin", b.args)
      expect(same.data).toMatchObject({ action: "replay", settlement_id: b.settlementId })
      const doc = b.args.p_document as { components: { charge_cents: number; component: string }[] }
      const changed = await db.rpc("commercial_settlement_begin", { ...b.args, p_document_digest: "f".repeat(64) })
      expect(changed.error?.code).toBe("CB409")
      const otherKey = await db.rpc("commercial_settlement_begin", { ...b.args, p_idempotency_key: "cset.v1." + "e".repeat(40) })
      expect(otherKey.error?.code).toBe("CB409")
      void doc
      expect(await rows("commercial_settlements", g.shop.shopId)).toHaveLength(1)
    })
  })

  describe("authority", () => {
    it("only a service-role caller naming a live owner of that exact shop can settle", async () => {
      const f = await fixture()
      const mgr = f.extra[0] // manager
      const stf = f.extra[1] // staff
      const { args } = await beginArgs(f)
      for (const [who, actor] of [["manager", mgr.ownerId], ["staff", stf.ownerId], ["a stranger's owner", stranger.shop.ownerId], ["unknown", "00000000-0000-4000-8000-00000000dead"]] as const) {
        const r = await db.rpc("commercial_settlement_begin", { ...args, p_actor: actor })
        expect(r.error?.code, who).toBe("42501")
      }
      // A revoked owner-turned-manager is not an owner either.
      const revoked = await db.from("shop_memberships").update({ active: false }).eq("shop_id", f.shop.shopId).eq("user_id", mgr.ownerId)
      expect(revoked.error).toBeNull()
      expect((await db.rpc("commercial_settlement_begin", { ...args, p_actor: mgr.ownerId })).error?.code).toBe("42501")
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(0)
    })

    it("browser roles cannot execute any settlement writer, and cannot touch the tables", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const b = await beginDirect(f)
      const anon = anonClient()
      const mgrSession = await ownerSessionClient((await db.auth.admin.getUserById(f.extra[0].ownerId)).data.user!.email!, PW).catch(() => null)
      const writers: [string, Record<string, unknown>][] = [
        ["commercial_settlement_begin", b.args],
        ["commercial_settlement_delivery_claim", { p_shop: f.shop.shopId, p_settlement: b.settlementId, p_line: b.lines.qualified_lead }],
        ["commercial_settlement_delivery_record", { p_shop: f.shop.shopId, p_settlement: b.settlementId, p_line: b.lines.qualified_lead, p_claim_token: b.settlementId, p_outcome: "delivered", p_code: null }],
        ["commercial_settlement_emit", { p_shop: f.shop.shopId, p_settlement: b.settlementId, p_line: null, p_kind: "delivery_delivered", p_actor: null, p_details: {} }],
        ["commercial_settlement_evidence_digest", { p_usage: {}, p_membership: {} }],
      ]
      for (const [name, params] of writers) {
        for (const [who, client] of [["owner", f.owner], ["anon", anon], ["cross-tenant owner", stranger.owner], ...(mgrSession ? [["manager", mgrSession] as const] : [])] as const) {
          const r = await client.rpc(name, params)
          expect(r.error, `${who} must not execute ${name}`).not.toBeNull()
          expect(["42501", "PGRST202"]).toContain(r.error!.code)
        }
      }
      for (const table of ["commercial_settlements", "commercial_settlement_lines", "commercial_settlement_events"]) {
        for (const client of [f.owner, anon]) {
          const read = await client.from(table).select("*")
          expect(read.error !== null || (read.data ?? []).length === 0, `${table} readable by a browser role`).toBe(true)
          const write = await client.from(table).insert({ shop_id: f.shop.shopId })
          expect(write.error).not.toBeNull()
        }
        // Even the service role has no direct write path.
        const direct = await db.from(table).insert({ shop_id: f.shop.shopId })
        expect(direct.error).not.toBeNull()
      }
      const tamper = await db.from("commercial_settlement_lines").update({ delivery_status: "delivered" }).eq("id", b.lines.qualified_lead).select()
      expect(tamper.error ?? (tamper.data ?? []).length === 0).toBeTruthy()
    })

    it("only the live owner (or the service role) can read evidence or a settlement, tenant-bound", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const b = await beginDirect(f)
      const anon = anonClient()
      const s1 = await ownerSessionClient((await db.auth.admin.getUserById(f.extra[1].ownerId)).data.user!.email!, PW).catch(() => null)
      const evidenceParams = { p_shop: f.shop.shopId, p_window_start: canon(W.windowStart), p_window_end: canon(W.windowEnd), p_as_of: null }
      const settlementParams = { p_shop: f.shop.shopId, p_window_start: canon(W.windowStart), p_window_end: canon(W.windowEnd) }
      expect((await f.owner.rpc("commercial_settlement_evidence", evidenceParams)).error).toBeNull()
      expect((await f.owner.rpc("commercial_settlement_read", settlementParams)).error).toBeNull()
      expect((await db.rpc("commercial_settlement_read", settlementParams)).error).toBeNull()
      for (const [who, client] of [["anon", anon], ["cross-tenant owner", stranger.owner], ...(s1 ? [["staff", s1] as const] : [])] as const) {
        expect((await client.rpc("commercial_settlement_evidence", evidenceParams)).error?.code, `${who} evidence`).toBe("42501")
        expect((await client.rpc("commercial_settlement_read", settlementParams)).error?.code, `${who} read`).toBe("42501")
      }
      expect(await readCommercialSettlement(stranger.owner, { shopId: f.shop.shopId, ...W })).toEqual({ status: "forbidden" })
      expect(await previewCommercialSettlement(stranger.owner, { shopId: f.shop.shopId, ...W })).toEqual({ status: "forbidden" })
      void b
      // The stranger's own read of the same window shows no settlement: tenant isolation.
      expect(await readCommercialSettlement(stranger.owner, { shopId: stranger.shop.shopId, ...W })).toEqual({ status: "none" })
    })
  })

  describe("immutability", () => {
    it("holds for every role including the table owner; only the shop cascade removes rows", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const fake = fakeProvider()
      const result = await settle(f, fake.runtime)
      if (!result.ok) throw new Error(JSON.stringify(result))
      const id = result.settlementId
      const refused = async (query: string, pattern: RegExp) => {
        const r = await sql(query)
        expect(r.ok, query).toBe(false)
        expect(r.message, query).toMatch(pattern)
      }
      await refused(`UPDATE public.commercial_settlements SET total_cents = 1 WHERE id='${id}'`, /immutable|check/i)
      await refused(`DELETE FROM public.commercial_settlements WHERE id='${id}'`, /cannot be deleted|immutable/i)
      await refused(`TRUNCATE public.commercial_settlements CASCADE`, /truncate|cannot/i)
      await refused(`TRUNCATE public.commercial_settlement_events`, /truncate|cannot/i)
      await refused(`UPDATE public.commercial_settlement_events SET kind='settlement_created' WHERE shop_id='${f.shop.shopId}'`, /immutable/i)
      await refused(`DELETE FROM public.commercial_settlement_events WHERE shop_id='${f.shop.shopId}'`, /cannot be deleted|immutable/i)
      await refused(`UPDATE public.commercial_settlement_lines SET charge_cents = 1 WHERE settlement_id='${id}'`, /immutable/i)
      await refused(`UPDATE public.commercial_settlement_lines SET event_value = 99 WHERE settlement_id='${id}' AND event_value IS NOT NULL`, /immutable/i)
      await refused(`UPDATE public.commercial_settlement_lines SET delivery_status = 'pending', claim_token = NULL WHERE settlement_id='${id}' AND delivery_status = 'delivered'`, /forward|immutable|check|write-once/i)
      await refused(`UPDATE public.commercial_settlement_lines SET claim_token = gen_random_uuid() WHERE settlement_id='${id}' AND delivery_status = 'delivered'`, /write-once|immutable|within a status/i)
      await refused(`DELETE FROM public.commercial_settlement_lines WHERE settlement_id='${id}'`, /cannot be deleted|immutable/i)
      // Live-mode is unrepresentable.
      await refused(`UPDATE public.commercial_settlements SET provider_mode = 'live' WHERE id='${id}'`, /immutable|check/i)
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(1)
      // The shop-deletion cascade (the existing tenant-deletion contract) is the only removal.
      const gone = await db.from("shops").delete().eq("id", f.shop.shopId)
      expect(gone.error).toBeNull()
      for (const table of ["commercial_settlements", "commercial_settlement_lines", "commercial_settlement_events"]) {
        expect(await rows(table, f.shop.shopId, "id")).toHaveLength(0)
      }
    })

    it("keeps event details free of URLs and key-shaped text", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const b = await beginDirect(f)
      const bad = await sql(`SELECT public.commercial_settlement_emit('${f.shop.shopId}','${b.settlementId}',NULL,'delivery_delivered',NULL,'{"x":"https://example.test/secret"}'::jsonb)`)
      expect(bad.ok).toBe(false)
      const key = await sql(`SELECT public.commercial_settlement_emit('${f.shop.shopId}','${b.settlementId}',NULL,'delivery_delivered',NULL,'{"x":"sk_test_abcdef"}'::jsonb)`)
      expect(key.ok).toBe(false)
    })
  })

  describe("configuration", () => {
    it("with an unprovisioned mapping nothing is settled and nothing is sent (the shipped F2 mapping is provisioned)", async () => {
      const f = await fixture()
      await recognizeOutcomes(f.shop.shopId, "qualified_lead", 1)
      const runtime: SettlementRuntime = { ok: false, reason: "settlement_mapping_unprovisioned" }
      expect(await settleCommercialPeriod(db, runtime, { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...W })).toMatchObject({ ok: false, reason: "runtime_unavailable" })
      expect(REVIEWED_SETTLEMENT_METER_MAPPING.status).toBe("provisioned")
      expect(await rows("commercial_settlements", f.shop.shopId)).toHaveLength(0)
    })
  })
})
