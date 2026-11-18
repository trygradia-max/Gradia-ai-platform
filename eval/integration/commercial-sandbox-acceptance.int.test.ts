import { createHmac } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { exactFixtureItems } from "../_commercial-item-fixtures"
import { dispatchPendingSettlementDeliveries, reconcileUnknownDeliveries } from "@/lib/commercial-billing-operations"
import { assessCommercialExecution } from "@/lib/commercial-execution-gate"
import { createMeterEvidenceReader } from "@/lib/commercial-settlement-provider"
import { previewCommercialSettlement, readCommercialSettlement, settleCommercialPeriod } from "@/lib/commercial-settlement-service"
import { handleCommercialWebhook } from "@/lib/commercial-webhook-service"
import { authorizeInvoiceReconstruction, reconstructInvoiceFromDocument } from "@/lib/stripe-sandbox-contract"
import { INTEGRATION_WITH_SESSION, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"
import { FakeStripeSandbox } from "../_fake-stripe-sandbox"
import { DAY_S, FAKE_CONFIG, PW, iso, recognizeOutcomes, recognizeSms, runtimeFor, settleableShop, sql, transient, uniq } from "./_commercial-fixture"

/**
 * PR F1 acceptance: the whole Founder Pilot lifecycle against a FAITHFUL LOCAL Stripe (test
 * clock + signed webhooks + meters + invoices), with the REAL database and the REAL provider
 * code. No network, no live Stripe. A real-Stripe test-clock run is the documented F2 slice.
 *
 *   checkout -> signed webhook -> active -> first activation boundary -> usage recognition ->
 *   allowance/cap preview -> meter dispatch -> invoice -> payment failure/lapse -> recovery ->
 *   cancel -> next period
 */
const SECRET = "whsec_" + "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"
const nowS = Math.floor(Date.now() / 1000)
const midnight = Math.floor(nowS / DAY_S) * DAY_S
const T0 = midnight - 75 * DAY_S // the subscription's first activation: UTC midnight, so seat proration stays defined
const P = (i: number) => ({ startS: T0 + 30 * i * DAY_S, endS: T0 + 30 * (i + 1) * DAY_S })
const win = (i: number) => ({ windowStart: iso(P(i).startS), windowEnd: iso(P(i).endS) })

let db: SupabaseClient
const seeded: Seeded[] = []
let evSeq = 0
const config = { ok: true as const, secret: SECRET }
const sign = (raw: string) => {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`
}
const deliver = (body: unknown) => {
  const raw = JSON.stringify(body)
  return handleCommercialWebhook({ getService: () => db, config }, { rawBody: raw, signatureHeader: sign(raw) })
}
const event = (type: string, object: Record<string, unknown>, created: number) => ({
  id: `evt_F1${uniq()}${++evSeq}`, object: "event", type, created, livemode: false, data: { object },
})

type Ctx = { s: Seeded; customerId: string; sub: string; attemptId: string; sessionId: string }
const subObject = (c: Ctx, status: string, period: { startS: number; endS: number }, extra: Record<string, unknown> = {}) => ({
  id: c.sub, object: "subscription", customer: c.customerId, status, livemode: false, start_date: T0,
  current_period_start: period.startS, current_period_end: period.endS, cancel_at_period_end: false, canceled_at: null,
  metadata: { shop_id: c.s.shopId, catalog_version: "2026-11-03.v1", plan_key: "founder-pilot", checkout_attempt_id: c.attemptId },
  items: { data: exactFixtureItems() }, ...extra,
})
const invoiceObject = (c: Ctx, id: string, amountDue: number, amountPaid: number, attempt = 1) => ({
  id, object: "invoice", livemode: false, customer: c.customerId, subscription: c.sub, amount_due: amountDue, amount_paid: amountPaid, currency: "usd", attempt_count: attempt,
})
const account = async (shopId: string) =>
  (await db.from("commercial_billing_accounts").select("state, state_reason").eq("shop_id", shopId).single()).data as { state: string; state_reason: string | null }

let agentSeq = 0
async function activateAgent(c: Ctx) {
  const agent = await db.from("custom_agents").insert({ shop_id: c.s.shopId, owner_id: c.s.ownerId, name: `F1 agent ${++agentSeq}`, problem_text: "Synthetic", config: {}, enabled: false }).select("id").single()
  expect(agent.error).toBeNull()
  const r = await db.rpc("commercial_agent_activate", { p_shop: c.s.shopId, p_actor: c.s.ownerId, p_agent: agent.data!.id })
  expect(r.error).toBeNull()
  return r.data as { outcome: string; code: string | null }
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("commercial sandbox acceptance (PR F1, faithful local Stripe)", () => {
  const fake = FakeStripeSandbox.provisioned(T0)
  let c: Ctx
  let owner: SupabaseClient

  beforeAll(async () => {
    db = serviceClient()
    const s = await transient(() => seedShop(db, { password: PW }))
    seeded.push(s)
    for (let i = 0; i < 3; i++) {
      const u = await transient(() => seedShop(db))
      seeded.push(u)
      expect((await db.from("shop_memberships").upsert({ shop_id: s.shopId, user_id: u.ownerId, role: i % 2 ? "staff" : "manager", capabilities: [], active: true, display_name: `m${i}` }, { onConflict: "shop_id,user_id" })).error).toBeNull()
    }
    // Coverage must precede the first activation (the application can never create coverage in the past).
    const backdate = iso(T0 - DAY_S)
    const r = await sql(`
      ALTER TABLE public.commercial_membership_events DISABLE TRIGGER commercial_membership_events_append_only;
      ALTER TABLE public.commercial_membership_coverage DISABLE TRIGGER commercial_membership_coverage_append_only;
      UPDATE public.commercial_membership_events SET effective_at='${backdate}', recorded_at='${backdate}' WHERE shop_id='${s.shopId}';
      UPDATE public.commercial_membership_coverage SET covered_from='${backdate}', recorded_at='${backdate}' WHERE shop_id='${s.shopId}';
      ALTER TABLE public.commercial_membership_events ENABLE TRIGGER commercial_membership_events_append_only;
      ALTER TABLE public.commercial_membership_coverage ENABLE TRIGGER commercial_membership_coverage_append_only;`)
    expect(r.ok, r.message).toBe(true)
    owner = await ownerSessionClient(s.email, PW)
    // Checkout exactly as PR C leaves it.
    const customerId = `cus_F1ACC${uniq()}`
    const sessionId = `cs_test_F1ACC${uniq()}`
    const begun = await db.rpc("commercial_checkout_begin", {
      p_shop: s.shopId, p_actor: s.ownerId, p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION, p_plan_key: "founder-pilot",
      p_lookup_key: FOUNDER_PILOT_PRICE.lookupKey, p_return_target: "agents", p_fingerprint: "a".repeat(64) })
    expect(begun.error).toBeNull()
    const attemptId = (begun.data as { attempt_id: string }).attempt_id
    expect((await db.rpc("commercial_checkout_bind_customer", { p_shop: s.shopId, p_actor: s.ownerId, p_attempt: attemptId, p_customer: customerId })).error).toBeNull()
    expect((await db.rpc("commercial_checkout_record_session", { p_shop: s.shopId, p_actor: s.ownerId, p_attempt: attemptId, p_session: sessionId })).error).toBeNull()
    c = { s, customerId, sub: `sub_F1ACC${uniq()}`, attemptId, sessionId }
  }, 120_000)

  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s).catch(() => undefined)
  }, 120_000)

  it("1. checkout completion alone is not active; the signed subscription at first activation is", async () => {
    expect(await activateAgent(c)).toMatchObject({ outcome: "blocked", code: "billing_not_active" })
    const completed = await deliver(event("checkout.session.completed", { id: c.sessionId, object: "checkout.session", livemode: false, mode: "subscription", customer: c.customerId, subscription: c.sub }, T0 + 30))
    expect(completed.body).toMatchObject({ outcome: "observed" })
    expect(await account(c.s.shopId)).toMatchObject({ state: "checkout_pending" })
    expect(await activateAgent(c)).toMatchObject({ outcome: "blocked", code: "billing_not_active" })

    const created = await deliver(event("customer.subscription.created", subObject(c, "active", P(0)), T0 + 60))
    expect(created.body).toMatchObject({ outcome: "applied" })
    expect(await account(c.s.shopId)).toMatchObject({ state: "active" })
    expect(await activateAgent(c)).toMatchObject({ outcome: "activated" }) // the first agent activation boundary
    const periods = (await db.from("commercial_subscription_periods").select("period_start, period_end").eq("shop_id", c.s.shopId).order("period_start")).data
    expect(periods).toHaveLength(1)
    expect(new Date(periods![0].period_start).getTime() / 1000).toBe(T0) // exact Stripe boundary from first activation
  })

  it("2. a calendar-month or shifted window is not the commercial period", async () => {
    for (const w of [{ windowStart: iso(T0), windowEnd: iso(T0 + 31 * DAY_S) }, { windowStart: iso(T0 + 3600), windowEnd: iso(P(0).endS + 3600) }]) {
      expect(await previewCommercialSettlement(owner, { shopId: c.s.shopId, ...w })).toMatchObject({ status: "blocked", blocks: ["subscription_period_not_verified"] })
    }
  })

  it("3. usage recognition -> allowance/cap preview -> settlement -> dispatch -> an invoice equal to the preview", async () => {
    const at = P(0).startS + 9 * DAY_S + 3600
    await recognizeOutcomes(db, c.s.shopId, "confirmed_appointment", 3, at)
    await recognizeOutcomes(db, c.s.shopId, "qualified_lead", 2, at)
    await recognizeOutcomes(db, c.s.shopId, "standard_digital_outcome", 104, at) // 100 included, 4 billed
    await recognizeSms(db, c.s.shopId, 40, "1.5", at)
    // Period 0 is closed (the DB clock) but the first webhook only verified P0; renewal evidence follows below.
    await deliver(event("customer.subscription.updated", subObject(c, "active", P(1)), P(1).startS + 30))
    const preview = await previewCommercialSettlement(owner, { shopId: c.s.shopId, ...win(0) })
    if (preview.status !== "ready") throw new Error(JSON.stringify(preview))
    const by = Object.fromEntries(preview.document.components.map((x) => [x.component, x]))
    expect(by.standard_digital_outcome).toMatchObject({ recognized_quantity: "104", billed_quantity: "4", charge_cents: 400 })
    expect(by.confirmed_appointment).toMatchObject({ billed_quantity: "3", charge_cents: 3000 })
    expect(by.qualified_lead).toMatchObject({ billed_quantity: "2", charge_cents: 1000 })
    expect(preview.document.usage_cents).toBeLessThanOrEqual(preview.document.usage_cap_cents)

    const rebuilt = reconstructInvoiceFromDocument(preview.document)
    expect(authorizeInvoiceReconstruction(preview.document, rebuilt)).toEqual({ ok: true })

    const settled = await settleCommercialPeriod(db, runtimeFor(fake), { shopId: c.s.shopId, actorId: c.s.ownerId, ...win(0), deferDelivery: true })
    if (!settled.ok) throw new Error(JSON.stringify(settled))
    expect(settled.delivery).toBe("pending")
    expect(fake.events.size).toBe(0)

    // Dispatch inside the invoice window: after the boundary, before the renewal invoice finalizes.
    fake.clock = P(0).endS + 300
    const dispatched = await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { shopId: c.s.shopId })
    expect(dispatched.ok && dispatched.report.delivered).toBeGreaterThanOrEqual(5)
    const read = await readCommercialSettlement(owner, { shopId: c.s.shopId, ...win(0) })
    expect(read).toMatchObject({ status: "settled", delivery: "provider_accepted" })

    // What Stripe was told is exactly the settled values, nothing else.
    const sent = Object.fromEntries([...fake.events.values()].map((e) => [e.eventName, e.value]))
    for (const [component, value] of Object.entries(rebuilt.eventValues)) {
      if (value !== "0") expect(sent[`gradia_fp_2026_11_${component}`], component).toBe(Number(value))
    }
    expect(sent.gradia_fp_2026_11_standard_digital_outcome).toBe(4)
    const invoice = fake.finalizeInvoice({ customer: c.customerId, periodStart: P(0).startS, periodEnd: P(0).endS, finalizedAt: P(0).endS + 3600 })
    expect(invoice.totalCents).toBe(preview.document.total_cents)
    expect(invoice.totalCents).toBeLessThanOrEqual(preview.document.base_cents + preview.document.seat_cents + preview.document.usage_cap_cents)
    expect(invoice.lateUnbilledEventCount).toBe(0)
    // Replaying the whole thing sends nothing new.
    await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { shopId: c.s.shopId })
    const replay = await settleCommercialPeriod(db, runtimeFor(fake), { shopId: c.s.shopId, actorId: c.s.ownerId, ...win(0) })
    expect(replay).toMatchObject({ ok: true, action: "replay" })
    expect([...fake.events.values()]).toHaveLength(Object.values(sent).length)
    expect(fake.duplicateMeterEventAttempts).toBe(0)
  })

  it("4. renewal 1 pays; renewal 2 FAILS: new paid work blocks, the closed period still settles, recovery restores it", async () => {
    // Renewal 1 (paid): evidence already delivered above; add its payment fact.
    await deliver(event("invoice.paid", invoiceObject(c, `in_F1${uniq()}`, 0, 19_900), P(1).startS + 40))
    // Renewal 2 (payment fails): the failure is a recorded fact and the signed status is the truth.
    await deliver(event("invoice.payment_failed", invoiceObject(c, `in_F1${uniq()}`, 19_900, 0, 1), P(2).startS + 20))
    const pastDue = await deliver(event("customer.subscription.updated", subObject(c, "past_due", P(2)), P(2).startS + 30))
    expect(pastDue.body).toMatchObject({ outcome: "applied" })
    expect(await account(c.s.shopId)).toMatchObject({ state: "past_due" })
    expect(await assessCommercialExecution(db, c.s.shopId)).toMatchObject({ allowed: false })
    expect(await activateAgent(c)).toMatchObject({ outcome: "blocked", code: "billing_not_active" })

    // The period that closed BEFORE the lapse is still owed: settle + dispatch it (chain P0 -> P1 verified).
    await recognizeOutcomes(db, c.s.shopId, "confirmed_appointment", 1, P(1).startS + 5 * DAY_S)
    const settled = await settleCommercialPeriod(db, runtimeFor(fake), { shopId: c.s.shopId, actorId: c.s.ownerId, ...win(1), deferDelivery: true })
    if (!settled.ok) throw new Error(JSON.stringify(settled))
    fake.clock = P(1).endS + 300
    await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { shopId: c.s.shopId })
    const doc = (await previewCommercialSettlement(owner, { shopId: c.s.shopId, ...win(1) }))
    if (doc.status !== "ready") throw new Error(JSON.stringify(doc))
    const inv1 = fake.finalizeInvoice({ customer: c.customerId, periodStart: P(1).startS, periodEnd: P(1).endS, finalizedAt: P(1).endS + 3600 })
    expect(inv1.totalCents).toBe(doc.document.total_cents)

    // Recovery: newer signed evidence only (a payment fact alone never changes the account).
    await deliver(event("invoice.paid", invoiceObject(c, `in_F1${uniq()}`, 0, 19_900, 2), P(2).startS + 3600))
    expect(await account(c.s.shopId)).toMatchObject({ state: "past_due" })
    await deliver(event("customer.subscription.updated", subObject(c, "active", P(2)), P(2).startS + 3700))
    expect(await account(c.s.shopId)).toMatchObject({ state: "active" })
    expect(await assessCommercialExecution(db, c.s.shopId)).toEqual({ allowed: true, mode: "commercial" })
    expect(await activateAgent(c)).toMatchObject({ outcome: "activated" })
    // A duplicate delivery of the same signed event is a no-op.
    const dup = event("customer.subscription.updated", subObject(c, "active", P(2)), P(2).startS + 3800)
    expect((await deliver(dup)).body).toMatchObject({ replayed: false })
    expect((await deliver(dup)).body).toMatchObject({ replayed: true })
  })

  it("5. cancel blocks new work; the open period cannot settle; no refund or credit is made", async () => {
    const canceled = await deliver(event("customer.subscription.deleted", subObject(c, "canceled", P(2), { canceled_at: nowS - 120 }), nowS - 120))
    expect(canceled.body).toMatchObject({ outcome: "applied" })
    expect(await account(c.s.shopId)).toMatchObject({ state: "canceled" })
    expect(await assessCommercialExecution(db, c.s.shopId)).toMatchObject({ allowed: false })
    // A late "active" for the canceled subscription never revives it.
    expect((await deliver(event("customer.subscription.updated", subObject(c, "active", P(2)), nowS - 60))).body).toMatchObject({ outcome: "not_current" })
    expect(await account(c.s.shopId)).toMatchObject({ state: "canceled" })
    // The still-open period is not settleable (the DB clock), and nothing was credited or refunded.
    expect(await previewCommercialSettlement(owner, { shopId: c.s.shopId, ...win(2) })).toMatchObject({ status: "blocked", blocks: expect.arrayContaining(["window_not_closed"]) })
    expect(fake.calls.filter((x) => x.method === "POST").every((x) => x.path === "/billing/meter_events")).toBe(true)
    expect((await db.from("commercial_settlement_adjustments").select("id").eq("shop_id", c.s.shopId)).data).toHaveLength(0)
  })
})

describe.skipIf(!INTEGRATION_WITH_SESSION)("combined cap, included usage and the invoice-finalization race (faithful local Stripe)", () => {
  const W = { startS: midnight - 60 * DAY_S, endS: midnight - 30 * DAY_S }
  const w = { windowStart: iso(W.startS), windowEnd: iso(W.endS) }
  const AT = W.startS + 10 * DAY_S
  beforeAll(() => {
    db = serviceClient()
  })
  afterAll(async () => {
    for (const s of seeded.slice(5)) await cleanup(db, s).catch(() => undefined)
  }, 120_000)

  it("usage exactly at the cap settles and Stripe's invoice never exceeds base + seats + cap", async () => {
    const f = await settleableShop(db, seeded, W)
    await recognizeOutcomes(db, f.shop.shopId, "confirmed_appointment", 10, AT) // 10 x $10 = $100 = the cap
    await recognizeOutcomes(db, f.shop.shopId, "standard_digital_outcome", 100, AT) // exactly the included allowance: billed 0
    const fakeAt = FakeStripeSandbox.provisioned(W.endS + 300)
    const settled = await settleCommercialPeriod(db, runtimeFor(fakeAt), { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...w })
    if (!settled.ok) throw new Error(JSON.stringify(settled))
    const preview = await previewCommercialSettlement(db, { shopId: f.shop.shopId, ...w })
    if (preview.status !== "ready") throw new Error(JSON.stringify(preview))
    expect(preview.document.usage_cents).toBe(10_000)
    expect([...fakeAt.events.values()].some((e) => e.eventName.endsWith("standard_digital_outcome"))).toBe(false) // included usage is not sent
    const inv = fakeAt.finalizeInvoice({ customer: f.customerId, periodStart: W.startS, periodEnd: W.endS, finalizedAt: W.endS + 3600 })
    expect(inv.totalCents).toBe(preview.document.total_cents)
    expect(inv.meteredCents).toBeLessThanOrEqual(preview.document.seat_cents + preview.document.usage_cap_cents)
  })

  it("usage over the cap cannot settle and sends nothing", async () => {
    const f = await settleableShop(db, seeded, W)
    await recognizeOutcomes(db, f.shop.shopId, "confirmed_appointment", 11, AT) // $110 > the $100 cap
    const fakeAt = FakeStripeSandbox.provisioned(W.endS + 300)
    expect(await previewCommercialSettlement(db, { shopId: f.shop.shopId, ...w })).toMatchObject({ status: "blocked", blocks: ["usage_cap_exceeded"] })
    expect(await settleCommercialPeriod(db, runtimeFor(fakeAt), { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...w })).toMatchObject({ ok: false, reason: "blocked", blocks: ["usage_cap_exceeded"] })
    expect(fakeAt.events.size).toBe(0)
    expect((await db.from("commercial_settlements").select("id").eq("shop_id", f.shop.shopId)).data).toHaveLength(0)
  })

  it("usage reaching Stripe AFTER the renewal invoice finalized is visibly unbilled, never silently billed (F2 must close this window)", async () => {
    const f = await settleableShop(db, seeded, W)
    await recognizeOutcomes(db, f.shop.shopId, "confirmed_appointment", 2, AT)
    const late = FakeStripeSandbox.provisioned(W.endS + 3 * 3600) // dispatcher ran 3 hours after the boundary
    await settleCommercialPeriod(db, runtimeFor(late), { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...w })
    const inv = late.finalizeInvoice({ customer: f.customerId, periodStart: W.startS, periodEnd: W.endS, finalizedAt: W.endS + 3600 })
    expect(inv.lateUnbilledEventCount).toBeGreaterThan(0)
    expect(inv.meteredCents).toBe(0)
    // Reconciliation would still confirm the provider holds the events: the gap is visible, not hidden.
    expect(inv.totalCents).toBeLessThan((await previewCommercialSettlement(db, { shopId: f.shop.shopId, ...w }) as { document: { total_cents: number } }).document.total_cents)
  })

  it("an ambiguous delivery found on reconciliation does not change what was settled", async () => {
    const f = await settleableShop(db, seeded, W)
    await recognizeOutcomes(db, f.shop.shopId, "confirmed_appointment", 1, AT)
    const fakeAt = FakeStripeSandbox.provisioned(W.endS + 300)
    fakeAt.failNext("timeout_after_record")
    const settled = await settleCommercialPeriod(db, runtimeFor(fakeAt), { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...w })
    if (!settled.ok) throw new Error(JSON.stringify(settled))
    expect(settled.delivery).toBe("reconciliation_required")
    const r = await reconcileUnknownDeliveries(db, createMeterEvidenceReader(FAKE_CONFIG, fakeAt.request), { shopId: f.shop.shopId })
    expect(r.ok && r.report.outcomes.confirmed_delivered).toBe(1)
    expect(fakeAt.events.size).toBe(Object.keys(settled.deliveries).length - settled.deliveries.filter((d) => d.outcome === "not_required").length)
    expect(fakeAt.duplicateMeterEventAttempts).toBe(0)
  })
})
