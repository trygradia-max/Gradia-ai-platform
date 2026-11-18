import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  applyApprovedAdjustments,
  createRuntimeEvidenceReader,
  dispatchPendingSettlementDeliveries,
  reconcileUnknownDeliveries,
  resolveAdjustmentRuntime,
  type AdjustmentRuntime,
} from "@/lib/commercial-billing-operations"
import { REVIEWED_SETTLEMENT_METER_MAPPING } from "@/lib/commercial-settlement"
import { resolveSettlementRuntime, type SettlementRuntime } from "@/lib/commercial-settlement-service"
import type { MeterEvidenceReader } from "@/lib/commercial-settlement-provider"
import { resolveCommercialStripeConfig } from "@/lib/stripe-commercial"
import { mappingMatchesSandboxContract } from "@/lib/stripe-sandbox-contract"
import { verifyStripeSandbox } from "@/lib/stripe-sandbox-verifier"

/**
 * The Commercial Billing worker (PR F2). Service-only: it is reached by the cron route (bearer CRON_SECRET) and by
 * nothing a browser can call. One bounded, leased sweep per task kind per invocation:
 *
 *   settlement_dispatch  pending / in-flight settlement lines -> the SAME claim/record functions as settlement
 *   delivery_reconcile   `unknown` lines -> append-only provider evidence (NEVER resends)
 *   adjustment_apply     human-APPROVED adjustments (either sign) -> one pending invoice item each
 *
 * Safety layering (each layer is independent):
 *   1. configuration: disabled unless explicitly enabled AND the PR C test-mode config is valid; a live key is refused;
 *   2. the dispatch task refuses to send unless the sandbox verifies against the contract (read-only) and the
 *      committed mapping equals that contract;
 *   3. the lease stops overlapping invocations from sweeping at once; every item is additionally claimed with a
 *      write-once token by the database, so even a lost lease cannot double-send;
 *   4. every sweep is bounded (item count and wall-clock budget) and stops BETWEEN items, never mid-call;
 *   5. every number sent comes from an immutable database row; tenant, period, customer and event never come from
 *      the request, the environment or a model. Reports carry counts and finite codes only: no ids, no payloads.
 * Nothing here creates a settlement, adjustment, review, refund, credit, cancellation or subscription state.
 */

export type WorkerKind = "settlement_dispatch" | "delivery_reconcile" | "adjustment_apply"
export const WORKER_KINDS: readonly WorkerKind[] = ["settlement_dispatch", "delivery_reconcile", "adjustment_apply"]

export const WORKER_ENABLE_FLAG = "GRADIA_COMMERCIAL_BILLING_WORKER"

export const WORKER_LIMITS: Readonly<{ maxSettlements: number; maxReconciliations: number; maxAdjustments: number; budgetMs: number; leaseTtlSeconds: number }> = {
  /** Settlements swept per invocation (each carries up to six lines). */
  maxSettlements: 10,
  maxReconciliations: 25,
  maxAdjustments: 10,
  /** No new item starts after this much wall clock; an in-flight item may finish (<= 6 x 15 s). */
  budgetMs: 120_000,
  leaseTtlSeconds: 300,
}

export type WorkerConfig =
  | { ok: true }
  | { ok: false; status: "disabled" }
  | { ok: false; status: "misconfigured"; reason: "billing_unconfigured" | "billing_misconfigured" | "mapping_contract_mismatch" }

/**
 * Disabled (not an error) unless `GRADIA_COMMERCIAL_BILLING_WORKER=enabled`. Enabled but with a missing / live-shaped /
 * non-loopback Stripe configuration, or a mapping that is not the exact sandbox contract, is `misconfigured` (an alert).
 */
export function resolveCommercialWorkerConfig(
  env: Record<string, string | undefined> = process.env,
  mapping = REVIEWED_SETTLEMENT_METER_MAPPING
): WorkerConfig {
  if (env[WORKER_ENABLE_FLAG]?.trim() !== "enabled") return { ok: false, status: "disabled" }
  const stripe = resolveCommercialStripeConfig(env)
  if (!stripe.ok) return { ok: false, status: "misconfigured", reason: stripe.reason }
  if (!mappingMatchesSandboxContract(mapping)) return { ok: false, status: "misconfigured", reason: "mapping_contract_mismatch" }
  return { ok: true }
}

// ---------- lease ----------

const acquireSchema = z.discriminatedUnion("acquired", [
  z.object({ acquired: z.literal(true), token: z.string().uuid(), generation: z.number().int() }),
  z.object({ acquired: z.literal(false), reason: z.string() }),
])
const renewSchema = z.object({ renewed: z.boolean() })
const releaseSchema = z.object({ released: z.boolean() })

export type LeaseOutcome = "completed" | "partial" | "failed" | "sandbox_not_ready" | "worker_misconfigured"

export type Lease = {
  /** True while this holder may keep working. Renews on each call; false once the lease was lost or the budget ended. */
  renew(): Promise<boolean>
  release(outcome: LeaseOutcome): Promise<void>
}

export async function acquireWorkerLease(
  service: SupabaseClient,
  worker: WorkerKind,
  ttlSeconds: number = WORKER_LIMITS.leaseTtlSeconds
): Promise<{ ok: true; lease: Lease } | { ok: false; reason: "lease_held" | "lease_unavailable" }> {
  const { data, error } = await service.rpc("commercial_worker_lease_acquire", { p_worker: worker, p_ttl_seconds: ttlSeconds })
  const parsed = acquireSchema.safeParse(data)
  if (error || !parsed.success) return { ok: false, reason: "lease_unavailable" }
  if (!parsed.data.acquired) return { ok: false, reason: "lease_held" }
  const token = parsed.data.token
  return {
    ok: true,
    lease: {
      async renew() {
        const renewed = await service.rpc("commercial_worker_lease_renew", { p_worker: worker, p_token: token, p_ttl_seconds: ttlSeconds })
        const result = renewSchema.safeParse(renewed.data)
        // An unreadable or failed renewal is a lost lease: stop rather than guess.
        return !renewed.error && result.success && result.data.renewed
      },
      async release(outcome) {
        const released = await service.rpc("commercial_worker_lease_release", { p_worker: worker, p_token: token, p_outcome: outcome })
        void releaseSchema.safeParse(released.data)
      },
    },
  }
}

// ---------- the run ----------

export type TaskReport =
  | { worker: WorkerKind; status: "ran"; outcome: LeaseOutcome; counts: Record<string, number>; stoppedEarly: boolean }
  | { worker: WorkerKind; status: "skipped"; reason: "lease_held" | "lease_unavailable" | "runtime_unavailable" }

export type WorkerRunReport = {
  ok: boolean
  tasks: TaskReport[]
}

export type WorkerDeps = {
  settlementRuntime: SettlementRuntime
  adjustmentRuntime: AdjustmentRuntime
  evidenceReader: MeterEvidenceReader | null
  /** True only when the read-only sandbox verification passes. Called once, only when dispatch has work. */
  sandboxReady: () => Promise<boolean>
  /** Operator/test scoping to one workspace. Omitted in production: the sweep is tenant-blind and each item is shop-bound. */
  shopId?: string
  nowMs?: () => number
  limits?: Partial<typeof WORKER_LIMITS>
}

export function resolveWorkerDeps(env: Record<string, string | undefined> = process.env): WorkerDeps {
  return {
    settlementRuntime: resolveSettlementRuntime(env),
    adjustmentRuntime: resolveAdjustmentRuntime(env),
    evidenceReader: createRuntimeEvidenceReader(env),
    sandboxReady: async () => {
      const verification = await verifyStripeSandbox(env)
      return verification.status === "checked" && verification.ready
    },
  }
}

export async function runCommercialBillingWorker(service: SupabaseClient, deps: WorkerDeps): Promise<WorkerRunReport> {
  const limits = { ...WORKER_LIMITS, ...deps.limits }
  const now = deps.nowMs ?? Date.now
  const tasks: TaskReport[] = []
  let ok = true

  for (const worker of WORKER_KINDS) {
    const taken = await acquireWorkerLease(service, worker, limits.leaseTtlSeconds)
    if (!taken.ok) {
      tasks.push({ worker, status: "skipped", reason: taken.reason })
      // A held lease is normal overlap; an unreadable lease store is not.
      if (taken.reason === "lease_unavailable") ok = false
      continue
    }
    const { lease } = taken
    const deadline = now() + limits.budgetMs
    let stopped = false
    // Before every item: still within budget AND the lease is still ours (renewal also extends it).
    const gate = async () => {
      if (now() >= deadline || !(await lease.renew())) {
        stopped = true
        return false
      }
      return true
    }
    let outcome: LeaseOutcome = "completed"
    let counts: Record<string, number> = {}
    try {
      if (worker === "settlement_dispatch") {
        const result = await dispatchPendingSettlementDeliveries(service, deps.settlementRuntime, {
          limit: limits.maxSettlements * 6,
          maxSettlements: limits.maxSettlements,
          shopId: deps.shopId,
          gate,
          preflight: deps.sandboxReady,
        })
        if (!result.ok) {
          if (result.reason === "runtime_unavailable") {
            await lease.release("worker_misconfigured")
            tasks.push({ worker, status: "skipped", reason: "runtime_unavailable" })
            ok = false
            continue
          }
          outcome = result.reason === "preflight_failed" ? "sandbox_not_ready" : "failed"
        } else {
          const { stoppedEarly, ...rest } = result.report
          counts = rest
          if (stoppedEarly) stopped = true
          if (rest.recordFailed > 0 || rest.unknown > 0 || rest.rejected > 0) outcome = "partial"
        }
      } else if (worker === "delivery_reconcile") {
        if (!deps.evidenceReader) {
          await lease.release("worker_misconfigured")
          tasks.push({ worker, status: "skipped", reason: "runtime_unavailable" })
          ok = false
          continue
        }
        const result = await reconcileUnknownDeliveries(service, deps.evidenceReader, { limit: limits.maxReconciliations, shopId: deps.shopId, gate })
        if (!result.ok) outcome = "failed"
        else {
          counts = { checked: result.report.checked, ...result.report.outcomes }
          if (result.report.stoppedEarly) stopped = true
          if (result.report.outcomes.read_failed > 0 || result.report.outcomes.record_failed > 0 || result.report.outcomes.mismatch > 0) outcome = "partial"
        }
      } else {
        const result = await applyApprovedAdjustments(service, deps.adjustmentRuntime, { limit: limits.maxAdjustments, shopId: deps.shopId, gate })
        if (!result.ok) {
          if (result.reason === "runtime_unavailable") {
            await lease.release("worker_misconfigured")
            tasks.push({ worker, status: "skipped", reason: "runtime_unavailable" })
            ok = false
            continue
          }
          outcome = "failed"
        } else {
          if (result.stoppedEarly) stopped = true
          for (const report of result.reports) counts[report.outcome] = (counts[report.outcome] ?? 0) + 1
          if (result.reports.some((r) => r.outcome === "record_failed" || r.outcome === "unknown" || r.outcome === "rejected")) outcome = "partial"
        }
      }
    } catch {
      // Never echo the error: it could carry configuration. The per-item claims keep every effect safe.
      outcome = "failed"
    }
    if (stopped && outcome === "completed") outcome = "partial"
    await lease.release(outcome)
    if (outcome === "failed" || outcome === "sandbox_not_ready") ok = false
    tasks.push({ worker, status: "ran", outcome, counts, stoppedEarly: stopped })
  }
  return { ok, tasks }
}
