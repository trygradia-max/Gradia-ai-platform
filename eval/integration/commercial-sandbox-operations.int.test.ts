import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  applyApprovedAdjustment,
  applyApprovedAdjustments,
  dispatchPendingSettlementDeliveries,
  reconcileUnknownDeliveries,
  type AdjustmentRuntime,
} from "@/lib/commercial-billing-operations"
import { createAdjustmentProvider } from "@/lib/commercial-adjustment-provider"
import { createMeterEvidenceReader } from "@/lib/commercial-settlement-provider"
import { readCommercialSettlement, settleCommercialPeriod } from "@/lib/commercial-settlement-service"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  cleanup,
  ownerSessionClient,
  type Seeded,
} from "./_db"
import { serviceClient } from "./_db"
import { FakeStripeSandbox } from "../_fake-stripe-sandbox"
import {
  DAY_S,
  FAKE_CONFIG,
  PW,
  iso,
  recognizeOutcomes,
  recognizeSms,
  rows,
  runtimeFor,
  settleableShop,
  sql,
  uniq,
  type Fixture,
} from "./_commercial-fixture"

const midnight = Math.floor(Date.now() / 1000 / DAY_S) * DAY_S
const W = { startS: midnight - 60 * DAY_S, endS: midnight - 30 * DAY_S }
const window = { windowStart: iso(W.startS), windowEnd: iso(W.endS) }
const AT = W.startS + 10 * DAY_S + 12 * 3600

let db: SupabaseClient
const seeded: Seeded[] = []
const fakeFor = () => FakeStripeSandbox.provisioned(midnight + 3600)
const adjRuntime = (fake: FakeStripeSandbox): AdjustmentRuntime => ({ ok: true, provider: createAdjustmentProvider(FAKE_CONFIG, fake.request) })

/** A settled period whose deliveries are still PENDING (the worker, not settle, owns delivery). */
async function settledPending(fake: FakeStripeSandbox, opts: { extraOperators?: number } = {}) {
  const f = await settleableShop(db, seeded, W, opts)
  await recognizeOutcomes(db, f.shop.shopId, "confirmed_appointment", 2, AT)
  await recognizeOutcomes(db, f.shop.shopId, "standard_digital_outcome", 103, AT)
  await recognizeSms(db, f.shop.shopId, 20, "1.5", AT)
  const settled = await settleCommercialPeriod(db, runtimeFor(fake), { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...window, deferDelivery: true })
  if (!settled.ok) throw new Error(JSON.stringify(settled))
  expect(settled.delivery).toBe("pending")
  return { f, settlementId: settled.settlementId }
}
const lines = async (shopId: string, settlementId: string) =>
  (await db.from("commercial_settlement_lines").select("id, component, delivery_status, failure_code, event_name, event_value, provider_identifier").eq("shop_id", shopId).eq("settlement_id", settlementId).order("component")).data as {
    id: string; component: string; delivery_status: string; failure_code: string | null; event_name: string | null; event_value: number | null; provider_identifier: string | null }[]
const dispatchOnly = async (fake: FakeStripeSandbox, shopId: string) => {
  const r = await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId })
  expect(r.ok).toBe(true)
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("commercial sandbox operations (PR F1)", () => {
  beforeAll(() => {
    db = serviceClient()
  })
  afterAll(async () => {
    for (const s of seeded) await cleanup(db, s).catch(() => undefined)
  }, 120_000)

  describe("dispatch sweep", () => {
    it("delivers every pending line once, with exactly the settled values, and is replay-safe", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      expect(fake.events.size).toBe(0) // settle sent nothing: the worker owns delivery
      await dispatchOnly(fake, f.shop.shopId)
      const after = await lines(f.shop.shopId, settlementId)
      const required = after.filter((l) => l.delivery_status !== "not_required")
      expect(required.map((l) => l.delivery_status)).toEqual(required.map(() => "delivered"))
      const mine = [...fake.events.values()].filter((e) => e.customer === f.customerId)
      expect(mine).toHaveLength(required.length)
      for (const line of required) {
        const ev = fake.events.get(line.provider_identifier as string)
        expect(ev).toMatchObject({ eventName: line.event_name, value: Number(line.event_value), customer: f.customerId })
      }
      await dispatchOnly(fake, f.shop.shopId)
      await dispatchOnly(fake, f.shop.shopId)
      expect([...fake.events.values()].filter((e) => e.customer === f.customerId)).toHaveLength(required.length)
      expect(fake.duplicateMeterEventAttempts).toBe(0)
    })

    it("four concurrent dispatchers send each event exactly once", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      await Promise.all(Array.from({ length: 4 }, () => dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })))
      const required = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status !== "not_required")
      expect(required.every((l) => l.delivery_status === "delivered")).toBe(true)
      expect([...fake.events.values()].filter((e) => e.customer === f.customerId)).toHaveLength(required.length)
      expect(fake.duplicateMeterEventAttempts).toBe(0)
    })

    it("a worker that crashed after claiming leaves the line in flight; later it is unknown and is never resent", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      const [target] = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "pending")
      const claimed = await db.rpc("commercial_settlement_delivery_claim", { p_shop: f.shop.shopId, p_settlement: settlementId, p_line: target.id })
      expect(claimed.data).toMatchObject({ action: "claimed" })
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      expect((await lines(f.shop.shopId, settlementId)).find((l) => l.id === target.id)!.delivery_status).toBe("in_flight") // live claim: left alone
      expect(fake.events.has(target.provider_identifier as string)).toBe(false)
      const aged = await sql(`ALTER TABLE public.commercial_settlement_lines DISABLE TRIGGER commercial_settlement_lines_guard;
        UPDATE public.commercial_settlement_lines SET claimed_at = claimed_at - interval '10 minutes' WHERE id='${target.id}';
        ALTER TABLE public.commercial_settlement_lines ENABLE TRIGGER commercial_settlement_lines_guard;`)
      expect(aged.ok, aged.message).toBe(true)
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      const row = (await lines(f.shop.shopId, settlementId)).find((l) => l.id === target.id)!
      expect(row).toMatchObject({ delivery_status: "unknown", failure_code: "stale_in_flight" })
      expect(fake.events.has(target.provider_identifier as string)).toBe(false) // never resent
    })
  })

  describe("ambiguous outcomes reconcile instead of resending", () => {
    it("a lost acknowledgement is unknown, never resent, and reconciliation confirms it from provider evidence", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      fake.failNext("timeout_after_record") // provider recorded it, the acknowledgement was lost
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      const unknown = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "unknown")
      expect(unknown).toHaveLength(1)
      expect(unknown[0].failure_code).toBe("provider_outcome_unknown")
      const sent = fake.events.size
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      expect(fake.events.size).toBe(sent)
      expect(fake.duplicateMeterEventAttempts).toBe(0)

      const reader = createMeterEvidenceReader(FAKE_CONFIG, fake.request)
      const first = await reconcileUnknownDeliveries(db, reader, { limit: 200, shopId: f.shop.shopId })
      expect(first.ok && first.report.outcomes.confirmed_delivered).toBeGreaterThanOrEqual(1)
      const rec = await rows<{ line_id: string; outcome: string; expected_value: number; observed_value: number }>(db, "commercial_delivery_reconciliations", f.shop.shopId, "recorded_at")
      expect(rec).toHaveLength(1)
      expect(rec[0]).toMatchObject({ line_id: unknown[0].id, outcome: "confirmed_delivered", expected_value: Number(unknown[0].event_value), observed_value: Number(unknown[0].event_value) })
      // The line is never rewritten; the evidence sits beside it. Confirmed lines leave the worklist.
      expect((await lines(f.shop.shopId, settlementId)).find((l) => l.id === unknown[0].id)!.delivery_status).toBe("unknown")
      await reconcileUnknownDeliveries(db, reader, { limit: 200, shopId: f.shop.shopId })
      expect(await rows(db, "commercial_delivery_reconciliations", f.shop.shopId)).toHaveLength(1)
      const read = await db.rpc("commercial_delivery_reconciliation_read", { p_shop: f.shop.shopId, p_settlement: settlementId })
      expect((read.data as { reconciliations: { outcome: string }[] }).reconciliations).toHaveLength(1)
    })

    it("a lost request is unknown; reconciliation finds nothing and still does not resend or confirm", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      fake.failNext("timeout_before_record")
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      const unknown = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "unknown")
      expect(unknown).toHaveLength(1)
      const reader = createMeterEvidenceReader(FAKE_CONFIG, fake.request)
      await reconcileUnknownDeliveries(db, reader, { limit: 200, shopId: f.shop.shopId })
      const rec = await rows<{ outcome: string; observed_value: number }>(db, "commercial_delivery_reconciliations", f.shop.shopId)
      expect(rec).toHaveLength(1)
      expect(rec[0]).toMatchObject({ outcome: "not_confirmed", observed_value: 0 })
      expect(fake.events.has(unknown[0].provider_identifier as string)).toBe(false) // evidence only: no resend
      // Asynchronous lag looks the same; it stays unresolved and can be checked again later (append-only).
      await reconcileUnknownDeliveries(db, reader, { limit: 200, shopId: f.shop.shopId })
      expect((await rows(db, "commercial_delivery_reconciliations", f.shop.shopId)).length).toBe(2)
    })

    it("a provider total above the ledger value is a mismatch, and an unreadable provider records nothing", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      fake.failNext("timeout_after_record")
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      const [u] = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "unknown")
      const stored = fake.events.get(u.provider_identifier as string)!
      fake.events.set("someone-else", { ...stored, identifier: "someone-else", value: 5 }) // unexplained extra usage in the same minute
      await reconcileUnknownDeliveries(db, createMeterEvidenceReader(FAKE_CONFIG, fake.request), { limit: 200, shopId: f.shop.shopId })
      expect((await rows<{ outcome: string }>(db, "commercial_delivery_reconciliations", f.shop.shopId)).map((r) => r.outcome)).toEqual(["mismatch"])
      const broken = createMeterEvidenceReader(FAKE_CONFIG, (async () => { throw new Error("boom") }) as never)
      const r = await reconcileUnknownDeliveries(db, broken, { limit: 200, shopId: f.shop.shopId })
      expect(r.ok && r.report.outcomes.read_failed).toBeGreaterThanOrEqual(1)
      expect(await rows(db, "commercial_delivery_reconciliations", f.shop.shopId)).toHaveLength(1)
    })

    it("only an unknown line is reconcilable, and a 4xx rejection is terminal (no resend)", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      fake.failNext("reject_400")
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      const all = await lines(f.shop.shopId, settlementId)
      const rejected = all.find((l) => l.delivery_status === "rejected")!
      const delivered = all.find((l) => l.delivery_status === "delivered")!
      for (const l of [rejected, delivered]) {
        const r = await db.rpc("commercial_delivery_reconcile_record", { p_shop: f.shop.shopId, p_settlement: settlementId, p_line: l.id, p_observed: 1, p_window_start: iso(Math.floor(W.endS / 60) * 60 - 60) })
        expect(r.error?.code).toBe("CB409")
      }
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      expect(fake.events.has(rejected.provider_identifier as string)).toBe(false)
    })

    it("refuses an observation window that does not contain the event, and a cross-shop line", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      fake.failNext("timeout_after_record")
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      const [u] = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "unknown")
      const bad = await db.rpc("commercial_delivery_reconcile_record", { p_shop: f.shop.shopId, p_settlement: settlementId, p_line: u.id, p_observed: 1, p_window_start: iso(W.startS) })
      expect(bad.error?.code).toBe("22023")
      const other = await settleableShop(db, seeded, W)
      const cross = await db.rpc("commercial_delivery_reconcile_record", { p_shop: other.shop.shopId, p_settlement: settlementId, p_line: u.id, p_observed: 1, p_window_start: iso(Math.floor(W.endS / 60) * 60 - 60) })
      expect(cross.error?.code).toBe("CB409")
    })
  })

  describe("authority, isolation and immutability", () => {
    it("browser roles can run no worker function; an owner can read only own evidence", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      const owner = await ownerSessionClient(f.shop.email, PW)
      const anon = anonClient()
      const calls: [string, Record<string, unknown>][] = [
        ["commercial_settlement_delivery_pending", { p_limit: 5 }],
        ["commercial_settlement_delivery_unresolved", { p_limit: 5 }],
        ["commercial_delivery_reconcile_record", { p_shop: f.shop.shopId, p_settlement: settlementId, p_line: f.shop.shopId, p_observed: 1, p_window_start: iso(0) }],
        ["commercial_adjustment_application_pending", { p_limit: 5 }],
        ["commercial_adjustment_application_claim", { p_shop: f.shop.shopId, p_adjustment: f.shop.shopId }],
        ["commercial_adjustment_application_record", { p_shop: f.shop.shopId, p_adjustment: f.shop.shopId, p_claim_token: f.shop.shopId, p_outcome: "applied", p_code: null }],
      ]
      for (const client of [owner, anon]) {
        for (const [fn, args] of calls) expect((await client.rpc(fn, args)).error?.code, fn).toBe("42501")
      }
      expect((await owner.rpc("commercial_delivery_reconciliation_read", { p_shop: f.shop.shopId, p_settlement: settlementId })).error).toBeNull()
      expect((await owner.rpc("commercial_adjustment_application_read", { p_shop: f.shop.shopId })).error).toBeNull()
      const stranger = await settleableShop(db, seeded, W, { extraOperators: 0 })
      const strangerOwner = await ownerSessionClient(stranger.shop.email, PW)
      expect((await strangerOwner.rpc("commercial_delivery_reconciliation_read", { p_shop: f.shop.shopId, p_settlement: settlementId })).error?.code).toBe("42501")
      expect((await strangerOwner.rpc("commercial_adjustment_application_read", { p_shop: f.shop.shopId })).error?.code).toBe("42501")
      expect((await anon.rpc("commercial_delivery_reconciliation_read", { p_shop: f.shop.shopId, p_settlement: settlementId })).error?.code).toBe("42501")
      for (const table of ["commercial_delivery_reconciliations", "commercial_adjustment_applications", "commercial_adjustment_application_events"]) {
        expect((await owner.from(table).select("*")).error, table).not.toBeNull()
        expect((await anon.from(table).select("*")).error, table).not.toBeNull()
      }
    })

    it("evidence tables are append-only for every role including the table owner", async () => {
      const fake = fakeFor()
      const { f, settlementId } = await settledPending(fake)
      fake.failNext("timeout_after_record")
      await dispatchPendingSettlementDeliveries(db, runtimeFor(fake), { limit: 200, shopId: f.shop.shopId })
      await reconcileUnknownDeliveries(db, createMeterEvidenceReader(FAKE_CONFIG, fake.request), { limit: 200, shopId: f.shop.shopId })
      const rec = await rows<{ id: string }>(db, "commercial_delivery_reconciliations", f.shop.shopId)
      expect(rec).toHaveLength(1)
      for (const stmt of [
        `UPDATE public.commercial_delivery_reconciliations SET observed_value = 1 WHERE id='${rec[0].id}'`,
        `DELETE FROM public.commercial_delivery_reconciliations WHERE id='${rec[0].id}'`,
        `TRUNCATE public.commercial_delivery_reconciliations`,
      ]) expect((await sql(stmt)).ok, stmt).toBe(false)
      // A confirmed reconciliation is final: the unique index refuses a second one.
      const dup = await sql(`INSERT INTO public.commercial_delivery_reconciliations (shop_id, settlement_id, line_id, outcome, expected_value, observed_value, window_start, window_end, line_failure_code)
        SELECT shop_id, settlement_id, line_id, outcome, expected_value, observed_value, window_start, window_end, line_failure_code FROM public.commercial_delivery_reconciliations WHERE id='${rec[0].id}'`)
      expect(dup.ok).toBe(false)
      expect((await readCommercialSettlement(db, { shopId: f.shop.shopId, windowStart: window.windowStart, windowEnd: window.windowEnd })).status).toBe("settled")
    })
  })

  describe("approved adjustments reach the next invoice; nothing else does", () => {
    async function adjustable(fake: FakeStripeSandbox, amount: number, decision: "approved" | "rejected" | "none") {
      const { f, settlementId } = await settledPending(fake)
      const idem = `f1-adj-${uniq()}-${"x".repeat(16)}`
      const p = await db.rpc("commercial_adjustment_propose", {
        p_shop: f.shop.shopId, p_settlement: settlementId, p_kind: "late_usage_evidence", p_signed_amount_cents: amount,
        p_reason_code: "late_usage", p_evidence_fact: null, p_idempotency_key: idem, p_proposed_by: "reviewed_operator" })
      expect(p.error).toBeNull()
      const adjustmentId = (p.data as { adjustment_id: string }).adjustment_id
      if (decision !== "none") {
        expect((await db.rpc("commercial_adjustment_review", { p_shop: f.shop.shopId, p_adjustment: adjustmentId, p_decision: decision, p_reviewer_ref: "reviewer:finance01", p_note: null })).error).toBeNull()
      }
      return { f, settlementId, adjustmentId }
    }

    it("an unreviewed or rejected adjustment, of EITHER sign, is never sent to the provider", async () => {
      const fake = fakeFor()
      for (const [amount, decision] of [[-2500, "none"], [-2500, "rejected"], [1800, "none"], [1800, "rejected"]] as const) {
        const a = await adjustable(fake, amount, decision)
        const r = await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: a.f.shop.shopId, adjustmentId: a.adjustmentId })
        expect(r).toMatchObject({ outcome: "not_approved" })
        expect(await rows(db, "commercial_adjustment_applications", a.f.shop.shopId)).toHaveLength(0)
        const sweep = await applyApprovedAdjustments(db, adjRuntime(fake), { limit: 200, shopId: a.f.shop.shopId })
        expect(sweep.ok && sweep.reports).toEqual([]) // not even on the worklist
      }
      expect(fake.items.size).toBe(0)
    })

    it("an approved credit and an approved charge each become exactly one signed pending invoice item and ride the next invoice", async () => {
      const fake = fakeFor()
      const credit = await adjustable(fake, -2500, "approved")
      const charge = await adjustable(fake, 1800, "approved")
      expect(await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: credit.f.shop.shopId, adjustmentId: credit.adjustmentId })).toMatchObject({ outcome: "applied" })
      expect(await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: charge.f.shop.shopId, adjustmentId: charge.adjustmentId })).toMatchObject({ outcome: "applied" })
      expect(await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: credit.f.shop.shopId, adjustmentId: credit.adjustmentId })).toMatchObject({ outcome: "already_applied" })
      expect(fake.items.size).toBe(2)
      expect([...fake.items.values()].map((i) => i.amount).sort((a, b) => a - b)).toEqual([-2500, 1800])
      expect(fake.calls.filter((c) => c.method === "POST").every((c) => c.path === "/invoiceitems")).toBe(true) // no refund, credit-note or payment call
      const apps = await rows<{ status: string; signed_amount_cents: number }>(db, "commercial_adjustment_applications", credit.f.shop.shopId)
      expect(apps).toEqual([expect.objectContaining({ status: "applied", signed_amount_cents: -2500 })])
      const events = await rows<{ kind: string }>(db, "commercial_adjustment_application_events", credit.f.shop.shopId, "recorded_at")
      expect(events.map((e) => e.kind)).toEqual(["claimed", "applied"])
      const inv = fake.finalizeInvoice({ customer: credit.f.customerId, periodStart: W.endS, periodEnd: W.endS + 30 * DAY_S, finalizedAt: W.endS + 30 * DAY_S })
      expect(inv.adjustmentCents).toBe(-2500)
    })

    it("six concurrent appliers create exactly one provider item; an ambiguous outcome is unknown and never resent", async () => {
      const fake = fakeFor()
      const a = await adjustable(fake, 900, "approved")
      const results = await Promise.all(Array.from({ length: 6 }, () => applyApprovedAdjustment(db, adjRuntime(fake), { shopId: a.f.shop.shopId, adjustmentId: a.adjustmentId })))
      expect(results.filter((r) => r.outcome === "applied")).toHaveLength(1)
      expect(fake.items.size).toBe(1)

      const b = await adjustable(fake, -700, "approved")
      fake.failNext("timeout_after_record")
      expect(await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: b.f.shop.shopId, adjustmentId: b.adjustmentId })).toMatchObject({ outcome: "unknown", code: "provider_outcome_unknown" })
      expect(await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: b.f.shop.shopId, adjustmentId: b.adjustmentId })).toMatchObject({ outcome: "blocked" })
      expect(fake.items.size).toBe(2) // the lost-ack item exists exactly once; it was never resent

      const c = await adjustable(fake, 300, "approved")
      fake.failNext("reject_400")
      expect(await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: c.f.shop.shopId, adjustmentId: c.adjustmentId })).toMatchObject({ outcome: "rejected" })
      const d = await adjustable(fake, 400, "approved")
      fake.failNext("bad_ack")
      expect(await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: d.f.shop.shopId, adjustmentId: d.adjustmentId })).toMatchObject({ outcome: "unknown", code: "response_mismatch" })
    })

    it("an adjustment of another workspace cannot be claimed through this one, and applications are immutable", async () => {
      const fake = fakeFor()
      const a = await adjustable(fake, 500, "approved")
      const other = await settleableShop(db, seeded, W)
      const cross = await db.rpc("commercial_adjustment_application_claim", { p_shop: other.shop.shopId, p_adjustment: a.adjustmentId })
      expect(cross.error?.code).toBe("CB409")
      await applyApprovedAdjustment(db, adjRuntime(fake), { shopId: a.f.shop.shopId, adjustmentId: a.adjustmentId })
      const [app] = await rows<{ id: string }>(db, "commercial_adjustment_applications", a.f.shop.shopId)
      for (const stmt of [
        `UPDATE public.commercial_adjustment_applications SET signed_amount_cents = 1 WHERE id='${app.id}'`,
        `UPDATE public.commercial_adjustment_applications SET status = 'in_flight' WHERE id='${app.id}'`,
        `DELETE FROM public.commercial_adjustment_applications WHERE id='${app.id}'`,
        `DELETE FROM public.commercial_adjustment_application_events WHERE application_id='${app.id}'`,
        `TRUNCATE public.commercial_adjustment_applications`,
      ]) expect((await sql(stmt)).ok, stmt).toBe(false)
    })
  })
})
