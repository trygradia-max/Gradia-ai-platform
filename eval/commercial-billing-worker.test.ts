import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

const { runCronSpy } = vi.hoisted(() => ({ runCronSpy: vi.fn() }))
vi.mock("@/lib/alerts", () => ({ sendOpsAlert: vi.fn(async () => ({ delivered: true })) }))
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: vi.fn(async () => ({ data: [], error: null })), from: () => ({ upsert: async () => ({ error: null }) }) }) }))

import { GET } from "@/app/api/cron/commercial-billing/route"
import {
  WORKER_ENABLE_FLAG,
  WORKER_KINDS,
  resolveCommercialWorkerConfig,
  runCommercialBillingWorker,
  type WorkerDeps,
} from "@/lib/commercial-billing-worker"
import { REVIEWED_SETTLEMENT_METER_MAPPING, type MeterMapping } from "@/lib/commercial-settlement"
import { mappingMatchesSandboxContract } from "@/lib/stripe-sandbox-contract"

const TEST_ENV = {
  [WORKER_ENABLE_FLAG]: "enabled",
  GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_FAKEFAKEFAKEFAKE0123",
}

describe("worker configuration (fail closed)", () => {
  it("is disabled, not an error, unless explicitly enabled", () => {
    expect(resolveCommercialWorkerConfig({})).toEqual({ ok: false, status: "disabled" })
    expect(resolveCommercialWorkerConfig({ ...TEST_ENV, [WORKER_ENABLE_FLAG]: "true" })).toEqual({ ok: false, status: "disabled" })
    expect(resolveCommercialWorkerConfig({ ...TEST_ENV, [WORKER_ENABLE_FLAG]: "" })).toEqual({ ok: false, status: "disabled" })
  })
  it("enabled with absent or live-shaped Stripe configuration is misconfigured, never run", () => {
    expect(resolveCommercialWorkerConfig({ [WORKER_ENABLE_FLAG]: "enabled" })).toEqual({ ok: false, status: "misconfigured", reason: "billing_unconfigured" })
    expect(resolveCommercialWorkerConfig({ ...TEST_ENV, STRIPE_SECRET_KEY: "sk_live_FAKEFAKEFAKEFAKE0123" })).toEqual({ ok: false, status: "misconfigured", reason: "billing_misconfigured" })
    expect(resolveCommercialWorkerConfig({ ...TEST_ENV, GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "live" })).toEqual({ ok: false, status: "misconfigured", reason: "billing_misconfigured" })
    expect(resolveCommercialWorkerConfig({ ...TEST_ENV, STRIPE_API_BASE: "https://evil.example/v1" })).toEqual({ ok: false, status: "misconfigured", reason: "billing_misconfigured" })
  })
  it("runs only with a valid TEST configuration and a mapping that is exactly the sandbox contract", () => {
    expect(resolveCommercialWorkerConfig(TEST_ENV)).toEqual({ ok: true })
    const drifted: MeterMapping = { ...REVIEWED_SETTLEMENT_METER_MAPPING, entries: REVIEWED_SETTLEMENT_METER_MAPPING.entries.map((e, i) => (i === 0 ? { ...e, eventName: "some_other_event" } : e)) }
    expect(mappingMatchesSandboxContract(drifted)).toBe(false)
    expect(resolveCommercialWorkerConfig(TEST_ENV, drifted)).toEqual({ ok: false, status: "misconfigured", reason: "mapping_contract_mismatch" })
    expect(mappingMatchesSandboxContract({ ...REVIEWED_SETTLEMENT_METER_MAPPING, status: "unprovisioned" })).toBe(false)
  })
})

describe("cron route authentication", () => {
  const req = (auth?: string) => new Request("http://localhost/api/cron/commercial-billing", { headers: auth ? { authorization: auth } : {} })
  beforeEach(() => {
    process.env.CRON_SECRET = "unit-cron-secret"
    delete process.env[WORKER_ENABLE_FLAG]
  })
  it("401s without the bearer secret, with a wrong one, and when the secret is unset", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req("Bearer nope"))).status).toBe(401)
    expect((await GET(req("unit-cron-secret"))).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req("Bearer undefined"))).status).toBe(401)
    expect((await GET(req("Bearer "))).status).toBe(401)
  })
  it("is a quiet 200 'disabled' by default and a 503 when enabled but misconfigured", async () => {
    const disabled = await GET(req("Bearer unit-cron-secret"))
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({ ok: true, status: "disabled" })
    process.env[WORKER_ENABLE_FLAG] = "enabled"
    delete process.env.STRIPE_SECRET_KEY
    const broken = await GET(req("Bearer unit-cron-secret"))
    expect(broken.status).toBe(503)
    expect(await broken.json()).toEqual({ ok: false, status: "misconfigured", reason: "billing_unconfigured" })
    delete process.env[WORKER_ENABLE_FLAG]
  })
  it("exports GET only (no browser-callable mutation verbs)", async () => {
    const mod = await import("@/app/api/cron/commercial-billing/route")
    expect(Object.keys(mod).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([])
  })
})

// ---- the run, against an in-memory lease store and worklists ----
function memoryService(opts: { held?: Partial<Record<string, boolean>>; renewOk?: () => boolean } = {}) {
  const calls: string[] = []
  const leases = new Map<string, string>()
  let seq = 0
  const rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    calls.push(name)
    switch (name) {
      case "commercial_worker_lease_acquire":
        if (opts.held?.[String(args.p_worker)] || leases.has(String(args.p_worker))) return { data: { acquired: false, reason: "lease_held" }, error: null }
        leases.set(String(args.p_worker), `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`)
        return { data: { acquired: true, token: leases.get(String(args.p_worker)), generation: seq }, error: null }
      case "commercial_worker_lease_renew":
        return { data: { renewed: opts.renewOk ? opts.renewOk() : true }, error: null }
      case "commercial_worker_lease_release":
        leases.delete(String(args.p_worker))
        return { data: { released: true }, error: null }
      case "commercial_settlement_delivery_pending":
      case "commercial_settlement_delivery_unresolved":
      case "commercial_adjustment_application_pending":
        return { data: [], error: null }
      default:
        // Any other database function is unavailable in this in-memory stand-in: a failed read, never a success.
        return { data: null, error: { code: "XX000", message: "unavailable" } }
    }
  })
  return { service: { rpc } as unknown as SupabaseClient, calls, leases }
}

const deps = (over: Partial<WorkerDeps> = {}): WorkerDeps => ({
  settlementRuntime: { ok: true, provider: { submitMeterEvent: vi.fn() }, mapping: REVIEWED_SETTLEMENT_METER_MAPPING },
  adjustmentRuntime: { ok: true, provider: { createPendingInvoiceItem: vi.fn() } },
  evidenceReader: { readObservedTotal: vi.fn() },
  sandboxReady: vi.fn(async () => true),
  ...over,
})

describe("the worker run", () => {
  it("leases each task kind, runs it bounded, and releases with a finite outcome", async () => {
    const { service, calls, leases } = memoryService()
    const report = await runCommercialBillingWorker(service, deps())
    expect(report.ok).toBe(true)
    expect(report.tasks.map((t) => t.worker)).toEqual([...WORKER_KINDS])
    expect(report.tasks.every((t) => t.status === "ran" && t.outcome === "completed")).toBe(true)
    expect(calls.filter((c) => c === "commercial_worker_lease_acquire")).toHaveLength(3)
    expect(calls.filter((c) => c === "commercial_worker_lease_release")).toHaveLength(3)
    expect(leases.size).toBe(0) // every lease handed back
    // An empty worklist never calls the sandbox (no needless provider reads).
    const d = deps()
    await runCommercialBillingWorker(memoryService().service, d)
    expect(d.sandboxReady).not.toHaveBeenCalled()
  })

  it("a held lease skips only that task (an overlapping invocation does no duplicate work)", async () => {
    const { service, calls } = memoryService({ held: { settlement_dispatch: true } })
    const report = await runCommercialBillingWorker(service, deps())
    expect(report.tasks[0]).toEqual({ worker: "settlement_dispatch", status: "skipped", reason: "lease_held" })
    expect(report.tasks[1]).toMatchObject({ worker: "delivery_reconcile", status: "ran" })
    expect(calls).not.toContain("commercial_settlement_delivery_pending")
    expect(report.ok).toBe(true) // overlap is normal, not an alert
  })

  it("an unreadable lease store fails closed: nothing is swept and the run is not ok", async () => {
    const rpc = vi.fn(async (..._args: unknown[]) => ({ data: null, error: { code: "42501", message: "x" } }))
    const report = await runCommercialBillingWorker({ rpc } as unknown as SupabaseClient, deps())
    expect(report.ok).toBe(false)
    expect(report.tasks.every((t) => t.status === "skipped" && t.reason === "lease_unavailable")).toBe(true)
    expect(rpc.mock.calls.every(([name]) => name === "commercial_worker_lease_acquire")).toBe(true)
  })

  it("a missing runtime (unconfigured provider) skips that task, releases the lease and reports not ok", async () => {
    const { service, leases } = memoryService()
    const report = await runCommercialBillingWorker(service, deps({ settlementRuntime: { ok: false, reason: "billing_unconfigured" }, evidenceReader: null, adjustmentRuntime: { ok: false, reason: "billing_misconfigured" } }))
    expect(report.ok).toBe(false)
    expect(report.tasks.every((t) => t.status === "skipped" && t.reason === "runtime_unavailable")).toBe(true)
    expect(leases.size).toBe(0)
  })

  it("a sweep stops BETWEEN items when the time budget ends or the lease is lost", async () => {
    const work = (n: number) => Array.from({ length: n }, (_, i) => ({ shop_id: "11111111-1111-4111-8111-111111111111", settlement_id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`, line_id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}` }))
    // Lease lost on the second renewal: exactly one settlement is processed, then the sweep stops.
    let renewals = 0
    const { service } = memoryService({ renewOk: () => ++renewals <= 1 })
    const original = service.rpc as unknown as (n: string, a?: Record<string, unknown>) => Promise<unknown>
    const wrapped = vi.fn(async (name: string, args?: Record<string, unknown>) =>
      name === "commercial_settlement_delivery_pending" ? { data: work(5), error: null } : original(name, args)
    )
    const lineRows = { data: [{ id: "33333333-3333-4333-8333-333333333333", component: "qualified_lead", delivery_status: "pending" }], error: null }
    const from = () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: async () => lineRows }) }) }) })
    const stopping = { rpc: wrapped, from } as unknown as SupabaseClient
    const report = await runCommercialBillingWorker(stopping, deps())
    const dispatch = report.tasks[0]
    expect(dispatch).toMatchObject({ worker: "settlement_dispatch", status: "ran", stoppedEarly: true })
    // Exactly one settlement was attempted (one line claim); the second gate call found the lease lost and stopped.
    expect(wrapped.mock.calls.filter(([n]) => n === "commercial_settlement_delivery_claim")).toHaveLength(1)
    expect(renewals).toBe(2)
  })

  it("dispatch refuses to send when the sandbox is not ready, and releases with sandbox_not_ready", async () => {
    const work = [{ shop_id: "11111111-1111-4111-8111-111111111111", settlement_id: "22222222-2222-4222-8222-222222222222", line_id: "33333333-3333-4333-8333-333333333333" }]
    const base = memoryService()
    const original = base.service.rpc as unknown as (n: string, a?: Record<string, unknown>) => Promise<unknown>
    const wrapped = vi.fn(async (name: string, args?: Record<string, unknown>) =>
      name === "commercial_settlement_delivery_pending" ? { data: work, error: null } : original(name, args)
    )
    const d = deps({ sandboxReady: vi.fn(async () => false) })
    const report = await runCommercialBillingWorker({ rpc: wrapped } as unknown as SupabaseClient, d)
    expect(report.ok).toBe(false)
    expect(report.tasks[0]).toMatchObject({ worker: "settlement_dispatch", status: "ran", outcome: "sandbox_not_ready" })
    expect(d.sandboxReady).toHaveBeenCalledTimes(1)
    expect(wrapped.mock.calls.map(([n]) => n)).not.toContain("commercial_settlement_delivery_claim")
    expect((d.settlementRuntime as unknown as { provider: { submitMeterEvent: ReturnType<typeof vi.fn> } }).provider.submitMeterEvent).not.toHaveBeenCalled()
    expect(base.leases.size).toBe(0)
  })

  it("a thrown error is reported as failed without echoing it, and the lease is still released", async () => {
    const base = memoryService()
    const original = base.service.rpc as unknown as (n: string, a?: Record<string, unknown>) => Promise<unknown>
    const wrapped = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "commercial_adjustment_application_pending") throw new Error("boom sk_test_SECRET")
      return original(name, args)
    })
    const report = await runCommercialBillingWorker({ rpc: wrapped } as unknown as SupabaseClient, deps())
    expect(report.ok).toBe(false)
    expect(JSON.stringify(report)).not.toContain("SECRET")
    expect(report.tasks[2]).toMatchObject({ worker: "adjustment_apply", outcome: "failed" })
    expect(base.leases.size).toBe(0)
  })
})
