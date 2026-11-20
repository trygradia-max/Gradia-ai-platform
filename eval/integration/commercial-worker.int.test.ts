import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { createAdjustmentProvider } from "@/lib/commercial-adjustment-provider"
import { WORKER_KINDS, acquireWorkerLease, runCommercialBillingWorker, type WorkerDeps } from "@/lib/commercial-billing-worker"
import { createMeterEvidenceReader } from "@/lib/commercial-settlement-provider"
import { settleCommercialPeriod } from "@/lib/commercial-settlement-service"
import { INTEGRATION_WITH_SESSION, anonClient, cleanup, ownerSessionClient, serviceClient, type Seeded } from "./_db"
import { FakeStripeSandbox } from "../_fake-stripe-sandbox"
import {
  DAY_S, FAKE_CONFIG, PW, iso, recognizeOutcomes, recognizeSms, rows, runtimeFor, settleableShop, sql, uniq,
} from "./_commercial-fixture"

const midnight = Math.floor(Date.now() / 1000 / DAY_S) * DAY_S
const W = { startS: midnight - 60 * DAY_S, endS: midnight - 30 * DAY_S }
const window = { windowStart: iso(W.startS), windowEnd: iso(W.endS) }
const AT = W.startS + 10 * DAY_S + 12 * 3600

let db: SupabaseClient
const seeded: Seeded[] = []

const depsFor = (fake: FakeStripeSandbox, shopId: string, over: Partial<WorkerDeps> = {}): WorkerDeps => ({
  settlementRuntime: runtimeFor(fake),
  adjustmentRuntime: { ok: true, provider: createAdjustmentProvider(FAKE_CONFIG, fake.request) },
  evidenceReader: createMeterEvidenceReader(FAKE_CONFIG, fake.request),
  // F3: the poll task runs too (nothing is due for these shops, so it makes no provider read and sends nothing).
  subscriptionPollReader: { listCustomerSubscriptions: async () => { throw new Error("unexpected poll read") }, retrieveCheckoutSession: async () => { throw new Error("unexpected poll read") } },
  sandboxReady: async () => true,
  shopId,
  limits: { maxSettlements: 200 },
  ...over,
})

async function settledPending(fake: FakeStripeSandbox) {
  const f = await settleableShop(db, seeded, W, {})
  await recognizeOutcomes(db, f.shop.shopId, "confirmed_appointment", 2, AT)
  await recognizeOutcomes(db, f.shop.shopId, "standard_digital_outcome", 103, AT)
  await recognizeSms(db, f.shop.shopId, 20, "1.5", AT)
  const settled = await settleCommercialPeriod(db, runtimeFor(fake), { shopId: f.shop.shopId, actorId: f.shop.ownerId, ...window, deferDelivery: true })
  if (!settled.ok) throw new Error(JSON.stringify(settled))
  return { f, settlementId: settled.settlementId }
}
const lines = async (shopId: string, settlementId: string) =>
  (await db.from("commercial_settlement_lines").select("id, component, delivery_status, provider_identifier, event_value").eq("shop_id", shopId).eq("settlement_id", settlementId)).data as {
    id: string; component: string; delivery_status: string; provider_identifier: string | null; event_value: number | null }[]
const leaseRow = async (worker: string) =>
  (await db.from("commercial_worker_leases").select("*").eq("worker", worker).single()).data as {
    worker: string; holder_token: string | null; lease_until: string | null; generation: number; last_outcome: string | null }
const forceExpire = async (worker: string) => {
  const r = await sql(`UPDATE public.commercial_worker_leases SET lease_until = clock_timestamp() - interval '1 second' WHERE worker='${worker}' AND holder_token IS NOT NULL`)
  expect(r.ok, r.message).toBe(true)
}
const freeAll = async () => {
  const r = await sql(`UPDATE public.commercial_worker_leases SET holder_token=NULL, lease_until=NULL`)
  expect(r.ok, r.message).toBe(true)
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("commercial billing worker + lease (PR F2)", () => {
  beforeAll(async () => {
    db = serviceClient()
    await freeAll()
  })
  afterAll(async () => {
    await freeAll()
    for (const s of seeded) await cleanup(db, s).catch(() => undefined)
  }, 120_000)

  describe("the lease", () => {
    it("exactly one of many concurrent acquirers wins; the loser is told it is held", async () => {
      await freeAll()
      const results = await Promise.all(Array.from({ length: 8 }, () => db.rpc("commercial_worker_lease_acquire", { p_worker: "adjustment_apply", p_ttl_seconds: 60 })))
      const data = results.map((r) => r.data as { acquired: boolean; reason?: string; retry_after_seconds?: number })
      expect(results.every((r) => r.error === null)).toBe(true)
      expect(data.filter((d) => d.acquired)).toHaveLength(1)
      for (const d of data.filter((x) => !x.acquired)) expect(d).toMatchObject({ reason: "lease_held" })
      await freeAll()
    })

    it("renews and releases only for the current holder; a taken-over (expired) holder changes nothing", async () => {
      await freeAll()
      const a = (await db.rpc("commercial_worker_lease_acquire", { p_worker: "delivery_reconcile", p_ttl_seconds: 60 })).data as { acquired: true; token: string; generation: number }
      expect(a.acquired).toBe(true)
      const wrong = "00000000-0000-4000-8000-00000000dead"
      expect((await db.rpc("commercial_worker_lease_renew", { p_worker: "delivery_reconcile", p_token: wrong })).data).toEqual({ renewed: false })
      expect((await db.rpc("commercial_worker_lease_release", { p_worker: "delivery_reconcile", p_token: wrong, p_outcome: "completed" })).data).toEqual({ released: false })
      expect((await leaseRow("delivery_reconcile")).holder_token).toBe(a.token)
      expect((await db.rpc("commercial_worker_lease_renew", { p_worker: "delivery_reconcile", p_token: a.token })).data).toEqual({ renewed: true })

      // The holder dies; the lease expires; another invocation takes over with a higher fencing generation.
      await forceExpire("delivery_reconcile")
      expect((await db.rpc("commercial_worker_lease_renew", { p_worker: "delivery_reconcile", p_token: a.token })).data).toEqual({ renewed: false }) // expired holder must stop
      const b = (await db.rpc("commercial_worker_lease_acquire", { p_worker: "delivery_reconcile", p_ttl_seconds: 60 })).data as { acquired: true; token: string; generation: number; expired_prior_holder: boolean }
      expect(b).toMatchObject({ acquired: true, expired_prior_holder: true })
      expect(b.generation).toBe(a.generation + 1)
      // The stale holder can neither renew nor release the new holder's lease.
      expect((await db.rpc("commercial_worker_lease_renew", { p_worker: "delivery_reconcile", p_token: a.token })).data).toEqual({ renewed: false })
      expect((await db.rpc("commercial_worker_lease_release", { p_worker: "delivery_reconcile", p_token: a.token, p_outcome: "failed" })).data).toEqual({ released: false })
      expect((await leaseRow("delivery_reconcile")).holder_token).toBe(b.token)
      expect((await db.rpc("commercial_worker_lease_release", { p_worker: "delivery_reconcile", p_token: b.token, p_outcome: "completed" })).data).toEqual({ released: true })
      const after = await leaseRow("delivery_reconcile")
      expect(after).toMatchObject({ holder_token: null, lease_until: null, last_outcome: "completed" })
      // Releasing twice is a no-op, not an error.
      expect((await db.rpc("commercial_worker_lease_release", { p_worker: "delivery_reconcile", p_token: b.token, p_outcome: "completed" })).data).toEqual({ released: false })
    })

    it("clamps the TTL, rejects unknown workers and outcomes, and never returns the token from the operator read", async () => {
      await freeAll()
      const taken = (await db.rpc("commercial_worker_lease_acquire", { p_worker: "settlement_dispatch", p_ttl_seconds: 1 })).data as { token: string }
      const row = await leaseRow("settlement_dispatch")
      expect(Date.parse(row.lease_until as string) - Date.now()).toBeGreaterThan(20_000) // floor of 30 s, never 1 s
      const big = (await db.rpc("commercial_worker_lease_renew", { p_worker: "settlement_dispatch", p_token: taken.token, p_ttl_seconds: 10_000_000 })).data
      expect(big).toEqual({ renewed: true })
      expect(Date.parse((await leaseRow("settlement_dispatch")).lease_until as string) - Date.now()).toBeLessThan(901_000) // ceiling of 15 min
      expect((await db.rpc("commercial_worker_lease_acquire", { p_worker: "evil_worker", p_ttl_seconds: 60 })).error?.code).toBe("22023")
      expect((await db.rpc("commercial_worker_lease_release", { p_worker: "settlement_dispatch", p_token: taken.token, p_outcome: "nonsense" })).error?.code).toBe("22023")
      const read = await db.rpc("commercial_worker_lease_read")
      expect(read.error).toBeNull()
      expect(JSON.stringify(read.data)).not.toContain(taken.token)
      expect((read.data as { worker: string }[]).map((r) => r.worker)).toEqual([...WORKER_KINDS].sort())
      await freeAll()
    })

    it("browser roles cannot touch leases; the table is not readable or writable except by function; rows cannot be deleted", async () => {
      const f = await settleableShop(db, seeded, W, {})
      const owner = await ownerSessionClient(f.shop.email, PW)
      const anon = anonClient()
      const calls: [string, Record<string, unknown>][] = [
        ["commercial_worker_lease_acquire", { p_worker: "adjustment_apply", p_ttl_seconds: 60 }],
        ["commercial_worker_lease_renew", { p_worker: "adjustment_apply", p_token: f.shop.shopId }],
        ["commercial_worker_lease_release", { p_worker: "adjustment_apply", p_token: f.shop.shopId, p_outcome: "completed" }],
        ["commercial_worker_lease_read", {}],
      ]
      for (const client of [owner, anon]) {
        for (const [fn, args] of calls) expect((await client.rpc(fn, args)).error?.code, fn).toBe("42501")
        expect((await client.from("commercial_worker_leases").select("*")).error).not.toBeNull()
      }
      // The service role may SELECT but not write directly.
      expect((await db.from("commercial_worker_leases").update({ generation: 99 }).eq("worker", "adjustment_apply")).error).not.toBeNull()
      expect((await db.from("commercial_worker_leases").delete().eq("worker", "adjustment_apply")).error).not.toBeNull()
      for (const stmt of [
        `DELETE FROM public.commercial_worker_leases`,
        `TRUNCATE public.commercial_worker_leases`,
        `UPDATE public.commercial_worker_leases SET worker='renamed' WHERE worker='adjustment_apply'`,
        `UPDATE public.commercial_worker_leases SET generation = 0 WHERE generation > 0`,
        `INSERT INTO public.commercial_worker_leases (worker) VALUES ('invented')`,
      ]) {
        const r = await sql(stmt)
        // `generation = 0 WHERE generation > 0` can legitimately match nothing; every other statement must be refused.
        if (!stmt.includes("generation = 0")) expect(r.ok, stmt).toBe(false)
      }
      expect((await db.from("commercial_worker_leases").select("worker")).data).toHaveLength(4) // three F2 workers + subscription_poll (F3)
    })

    it("acquireWorkerLease reports a held lease and hands a working Lease to the holder", async () => {
      await freeAll()
      const first = await acquireWorkerLease(db, "adjustment_apply", 60)
      expect(first.ok).toBe(true)
      expect(await acquireWorkerLease(db, "adjustment_apply", 60)).toEqual({ ok: false, reason: "lease_held" })
      if (first.ok) {
        expect(await first.lease.renew()).toBe(true)
        await first.lease.release("completed")
      }
      expect((await acquireWorkerLease(db, "adjustment_apply", 60)).ok).toBe(true)
      await freeAll()
    })
  })

  describe("the worker, end to end against the real database and a faithful Stripe fake", () => {
    it("dispatches every pending line once with exactly the settled values; overlapping and repeated runs send nothing twice", async () => {
      await freeAll()
      const fake = FakeStripeSandbox.provisioned(midnight + 3600)
      const { f, settlementId } = await settledPending(fake)
      expect(fake.events.size).toBe(0)
      const reports = await Promise.all(Array.from({ length: 4 }, () => runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))))
      await runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))
      const required = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status !== "not_required")
      expect(required.length).toBeGreaterThan(0)
      expect(required.every((l) => l.delivery_status === "delivered")).toBe(true)
      const mine = [...fake.events.values()].filter((e) => e.customer === f.customerId)
      expect(mine).toHaveLength(required.length)
      expect(fake.duplicateMeterEventAttempts).toBe(0)
      for (const l of required) expect(fake.events.get(l.provider_identifier as string)).toMatchObject({ value: Number(l.event_value), customer: f.customerId })
      // Overlap was visible and harmless: at least one invocation skipped a held lease, or all ran in sequence.
      for (const r of reports) expect(r.tasks.map((t) => t.worker)).toEqual([...WORKER_KINDS])
      // Every lease was handed back.
      expect((await db.from("commercial_worker_leases").select("holder_token").not("holder_token", "is", null)).data).toEqual([])
    })

    it("a lease held by someone else makes the worker do nothing for that task", async () => {
      await freeAll()
      const fake = FakeStripeSandbox.provisioned(midnight + 3600)
      const { f, settlementId } = await settledPending(fake)
      const held = await acquireWorkerLease(db, "settlement_dispatch", 120)
      expect(held.ok).toBe(true)
      const report = await runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))
      expect(report.tasks[0]).toEqual({ worker: "settlement_dispatch", status: "skipped", reason: "lease_held" })
      expect(fake.events.size).toBe(0)
      expect((await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "pending").length).toBeGreaterThan(0)
      // The foreign lease is untouched by the worker's own release calls.
      expect((await leaseRow("settlement_dispatch")).holder_token).not.toBeNull()
      await freeAll()
    })

    it("fails closed when the sandbox is not ready: nothing is claimed or sent, and the run is not ok", async () => {
      await freeAll()
      const fake = FakeStripeSandbox.provisioned(midnight + 3600)
      const { f, settlementId } = await settledPending(fake)
      const report = await runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId, { sandboxReady: async () => false }))
      expect(report.ok).toBe(false)
      expect(report.tasks[0]).toMatchObject({ worker: "settlement_dispatch", outcome: "sandbox_not_ready" })
      expect(fake.events.size).toBe(0)
      expect((await lines(f.shop.shopId, settlementId)).every((l) => l.delivery_status === "pending" || l.delivery_status === "not_required")).toBe(true)
      expect((await leaseRow("settlement_dispatch")).last_outcome).toBe("sandbox_not_ready")
      // Once the sandbox verifies, the very same pending lines are delivered (nothing was lost or double-claimed).
      await runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))
      expect((await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "pending")).toHaveLength(0)
    })

    it("an ambiguous delivery becomes unknown, is never resent, and the worker reconciles it from provider evidence exactly once", async () => {
      await freeAll()
      const fake = FakeStripeSandbox.provisioned(midnight + 3600)
      const { f, settlementId } = await settledPending(fake)
      fake.failNext("timeout_after_record")
      await runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))
      const unknown = (await lines(f.shop.shopId, settlementId)).filter((l) => l.delivery_status === "unknown")
      expect(unknown).toHaveLength(1)
      const sent = fake.events.size
      // Two overlapping runs, then more: evidence is recorded once (confirmed is final) and nothing is ever resent.
      await Promise.all([runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId)), runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))])
      await runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))
      expect(fake.events.size).toBe(sent)
      expect(fake.duplicateMeterEventAttempts).toBe(0)
      const rec = await rows<{ outcome: string }>(db, "commercial_delivery_reconciliations", f.shop.shopId)
      expect(rec.map((r) => r.outcome)).toEqual(["confirmed_delivered"])
      expect((await lines(f.shop.shopId, settlementId)).find((l) => l.id === unknown[0].id)!.delivery_status).toBe("unknown") // never rewritten
    })

    it("applies only human-approved adjustments, once, and never sends an unreviewed one", async () => {
      await freeAll()
      const fake = FakeStripeSandbox.provisioned(midnight + 3600)
      const { f, settlementId } = await settledPending(fake)
      const propose = async (amount: number) => {
        const p = await db.rpc("commercial_adjustment_propose", {
          p_shop: f.shop.shopId, p_settlement: settlementId, p_kind: "late_usage_evidence", p_signed_amount_cents: amount,
          p_reason_code: "late_usage", p_evidence_fact: null, p_idempotency_key: `f2-adj-${uniq()}-${"x".repeat(16)}`, p_proposed_by: "reviewed_operator" })
        expect(p.error).toBeNull()
        return (p.data as { adjustment_id: string }).adjustment_id
      }
      const approvedCredit = await propose(-2500)
      await propose(1800) // never reviewed
      expect((await db.rpc("commercial_adjustment_review", { p_shop: f.shop.shopId, p_adjustment: approvedCredit, p_decision: "approved", p_reviewer_ref: "reviewer:finance01", p_note: null })).error).toBeNull()
      await Promise.all([runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId)), runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))])
      await runCommercialBillingWorker(db, depsFor(fake, f.shop.shopId))
      expect(fake.items.size).toBe(1)
      expect([...fake.items.values()][0].amount).toBe(-2500)
      expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/invoiceitems")).toHaveLength(1)
      expect(fake.calls.some((c) => /refund|credit_notes|cancel/.test(c.path))).toBe(false)
    })

    it("is tenant-safe: scoping to one workspace never touches another workspace's pending lines", async () => {
      await freeAll()
      const fake = FakeStripeSandbox.provisioned(midnight + 3600)
      const a = await settledPending(fake)
      const b = await settledPending(fake)
      await runCommercialBillingWorker(db, depsFor(fake, a.f.shop.shopId))
      const statusesOf = async (shopId: string, settlementId: string) => (await lines(shopId, settlementId)).map((l) => l.delivery_status)
      expect((await statusesOf(a.f.shop.shopId, a.settlementId)).filter((s) => s === "pending")).toHaveLength(0)
      expect((await statusesOf(b.f.shop.shopId, b.settlementId)).filter((s) => s === "delivered")).toHaveLength(0)
      expect([...fake.events.values()].some((e) => e.customer === b.f.customerId)).toBe(false)
    })
  })
})
