import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  ADJUSTMENT_DESCRIPTION,
  classifyProviderFailure,
  createAdjustmentProvider,
  verifyInvoiceItemAck,
  type AdjustmentProvider,
} from "@/lib/commercial-adjustment-provider"
import {
  deliverCommercialSettlement,
  type DeliveryReport,
  type SettlementRuntime,
} from "@/lib/commercial-settlement-service"
import { createMeterEvidenceReader, type MeterEvidenceReader } from "@/lib/commercial-settlement-provider"
import { resolveCommercialStripeConfig } from "@/lib/stripe-commercial"

/**
 * Operational workers for the sandbox (Commercial Billing PR F1). Service role only; a system
 * actor, never a request. Every number sent comes from an immutable database row; nothing is
 * derived from UI, model text or metadata.
 *
 *  - dispatchPendingSettlementDeliveries: sweeps pending/in-flight lines through the SAME claim
 *    and record functions as settlement, so a crash, a retry or a second worker cannot double-send.
 *  - reconcileUnknownDeliveries: reads what the provider reported for an `unknown` line and
 *    records it as append-only evidence. It NEVER resends.
 *  - applyApprovedAdjustments: carries only human-APPROVED adjustments (either sign) to the
 *    provider as one pending invoice item each.
 */

// ---------- dispatch ----------

const worklistSchema = z.array(z.object({ shop_id: z.string().uuid(), settlement_id: z.string().uuid(), line_id: z.string().uuid() }))

/**
 * Per-item hooks supplied by the worker (PR F2). `gate` runs before EVERY item: it renews the lease and checks the time
 * budget, and returns false to stop (never mid-item). `preflight` runs once, only when there is work, before anything is
 * sent. Both are optional so the F1 entry points behave exactly as before.
 */
export type ItemGate = () => Promise<boolean>

export type DispatchReport = {
  /** True when the gate stopped the sweep early; the remainder is picked up by the next run. */
  stoppedEarly?: true
  settlements: number
  delivered: number
  alreadyDelivered: number
  rejected: number
  unknown: number
  inProgress: number
  blocked: number
  recordFailed: number
  notRequired: number
}

const emptyReport = (): DispatchReport => ({
  settlements: 0, delivered: 0, alreadyDelivered: 0, rejected: 0, unknown: 0, inProgress: 0, blocked: 0, recordFailed: 0, notRequired: 0,
})

function tally(report: DispatchReport, deliveries: DeliveryReport[]) {
  for (const d of deliveries) {
    switch (d.outcome) {
      case "delivered": report.delivered++; break
      case "already_delivered": report.alreadyDelivered++; break
      case "rejected": report.rejected++; break
      case "unknown": report.unknown++; break
      case "in_progress": report.inProgress++; break
      case "blocked": report.blocked++; break
      case "record_failed": report.recordFailed++; break
      case "not_required": report.notRequired++; break
    }
  }
}

export async function dispatchPendingSettlementDeliveries(
  serviceClient: SupabaseClient,
  runtime: SettlementRuntime,
  options: { limit?: number; shopId?: string; maxSettlements?: number; gate?: ItemGate; preflight?: () => Promise<boolean> } = {}
): Promise<{ ok: true; report: DispatchReport } | { ok: false; reason: "runtime_unavailable" | "worklist_failed" | "preflight_failed" }> {
  if (!runtime.ok) return { ok: false, reason: "runtime_unavailable" }
  const listed = await serviceClient.rpc("commercial_settlement_delivery_pending", { p_limit: options.limit ?? 50, p_shop: options.shopId ?? null })
  const parsed = worklistSchema.safeParse(listed.data)
  if (listed.error || !parsed.success) return { ok: false, reason: "worklist_failed" }
  // Nothing is sent unless the sandbox verifies against the contract (read-only); only checked when there is work.
  if (parsed.data.length > 0 && options.preflight && !(await options.preflight())) return { ok: false, reason: "preflight_failed" }
  const seen = new Set<string>()
  const report = emptyReport()
  for (const item of parsed.data) {
    const key = `${item.shop_id}:${item.settlement_id}`
    if (seen.has(key)) continue
    if (options.maxSettlements !== undefined && seen.size >= options.maxSettlements) {
      report.stoppedEarly = true
      break
    }
    if (options.gate && !(await options.gate())) {
      report.stoppedEarly = true
      break
    }
    seen.add(key)
    const result = await deliverCommercialSettlement(serviceClient, runtime, { shopId: item.shop_id, settlementId: item.settlement_id })
    report.settlements++
    if (result.ok) tally(report, result.deliveries)
    else report.recordFailed++
  }
  return { ok: true, report }
}

// ---------- reconcile ----------

const unresolvedSchema = z.array(
  z.object({
    shop_id: z.string().uuid(),
    settlement_id: z.string().uuid(),
    line_id: z.string().uuid(),
    event_name: z.string(),
    event_value: z.string().regex(/^[1-9][0-9]*$/),
    event_timestamp: z.string(),
    stripe_customer_id: z.string(),
  })
)

export type ReconcileOutcome = "confirmed_delivered" | "not_confirmed" | "mismatch" | "read_failed" | "record_failed"
export type ReconcileReport = { checked: number; outcomes: Record<ReconcileOutcome, number>; stoppedEarly?: true }

/** The provider's summary grain: the minute (aligned) containing the event timestamp. */
export const minuteStartSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000 / 60) * 60

export function createRuntimeEvidenceReader(env: Record<string, string | undefined> = process.env): MeterEvidenceReader | null {
  const config = resolveCommercialStripeConfig(env)
  return config.ok ? createMeterEvidenceReader(config.config) : null
}

export async function reconcileUnknownDeliveries(
  serviceClient: SupabaseClient,
  reader: MeterEvidenceReader,
  options: { limit?: number; shopId?: string; gate?: ItemGate } = {}
): Promise<{ ok: true; report: ReconcileReport } | { ok: false; reason: "worklist_failed" }> {
  const listed = await serviceClient.rpc("commercial_settlement_delivery_unresolved", { p_limit: options.limit ?? 50, p_shop: options.shopId ?? null })
  const parsed = unresolvedSchema.safeParse(listed.data)
  if (listed.error || !parsed.success) return { ok: false, reason: "worklist_failed" }
  const report: ReconcileReport = {
    checked: 0,
    outcomes: { confirmed_delivered: 0, not_confirmed: 0, mismatch: 0, read_failed: 0, record_failed: 0 },
  }
  for (const line of parsed.data) {
    if (options.gate && !(await options.gate())) {
      report.stoppedEarly = true
      break
    }
    report.checked++
    const start = minuteStartSeconds(line.event_timestamp)
    let observed: number
    try {
      observed = await reader.readObservedTotal({ eventName: line.event_name, customerId: line.stripe_customer_id, startSeconds: start })
    } catch {
      // Unreadable or ambiguous evidence records nothing. The line stays `unknown`.
      report.outcomes.read_failed++
      continue
    }
    const recorded = await serviceClient.rpc("commercial_delivery_reconcile_record", {
      p_shop: line.shop_id,
      p_settlement: line.settlement_id,
      p_line: line.line_id,
      p_observed: observed,
      p_window_start: new Date(start * 1000).toISOString(),
    })
    const outcome = (recorded.data as { outcome?: string } | null)?.outcome
    if (recorded.error || (outcome !== "confirmed_delivered" && outcome !== "not_confirmed" && outcome !== "mismatch")) {
      report.outcomes.record_failed++
    } else {
      report.outcomes[outcome]++
    }
  }
  return { ok: true, report }
}

// ---------- approved adjustments ----------

export type AdjustmentRuntime =
  | { ok: true; provider: AdjustmentProvider }
  | { ok: false; reason: "billing_unconfigured" | "billing_misconfigured" }

export function resolveAdjustmentRuntime(env: Record<string, string | undefined> = process.env): AdjustmentRuntime {
  const config = resolveCommercialStripeConfig(env)
  return config.ok ? { ok: true, provider: createAdjustmentProvider(config.config) } : config
}

const adjustmentWorklist = z.array(z.object({ shop_id: z.string().uuid(), adjustment_id: z.string().uuid() }))
const adjustmentClaim = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("claimed"),
    claim_token: z.string().uuid(),
    adjustment_id: z.string().uuid(),
    signed_amount_cents: z.number().int(),
    currency: z.literal("usd"),
    stripe_customer_id: z.string(),
    provider_identifier: z.string(),
  }),
  z.object({ action: z.literal("in_progress") }),
  z.object({ action: z.literal("applied") }),
  z.object({ action: z.literal("blocked"), status: z.string(), failure_code: z.string().nullable() }),
])

export type AdjustmentOutcome = "applied" | "already_applied" | "rejected" | "unknown" | "in_progress" | "blocked" | "not_approved" | "record_failed"
export type AdjustmentReport = { adjustmentId: string; outcome: AdjustmentOutcome; code?: string }

/**
 * Applies ONE adjustment. The database refuses it unless a human reviewer approved it (CB409
 * `not_approved`), whatever its sign. An ambiguous provider outcome is recorded `unknown` and is
 * never resent.
 */
export async function applyApprovedAdjustment(
  serviceClient: SupabaseClient,
  runtime: AdjustmentRuntime,
  args: { shopId: string; adjustmentId: string }
): Promise<AdjustmentReport> {
  const id = args.adjustmentId
  if (!runtime.ok) return { adjustmentId: id, outcome: "blocked", code: runtime.reason }
  const claimed = await serviceClient.rpc("commercial_adjustment_application_claim", { p_shop: args.shopId, p_adjustment: id })
  if (claimed.error) {
    return { adjustmentId: id, outcome: claimed.error.code === "CB409" ? "not_approved" : "record_failed", code: claimed.error.code === "CB409" ? "not_approved" : "claim_failed" }
  }
  const claim = adjustmentClaim.safeParse(claimed.data)
  if (!claim.success) return { adjustmentId: id, outcome: "record_failed", code: "malformed_claim" }
  const c = claim.data
  if (c.action === "applied") return { adjustmentId: id, outcome: "already_applied" }
  if (c.action === "in_progress") return { adjustmentId: id, outcome: "in_progress" }
  if (c.action === "blocked") return { adjustmentId: id, outcome: "blocked", ...(c.failure_code ? { code: c.failure_code } : {}) }

  const record = async (outcome: "applied" | "rejected" | "unknown", code: string | null): Promise<AdjustmentReport> => {
    const recorded = await serviceClient.rpc("commercial_adjustment_application_record", {
      p_shop: args.shopId, p_adjustment: id, p_claim_token: c.claim_token, p_outcome: outcome, p_code: code,
    })
    // A failed record leaves it in flight; the next claim marks it unknown. It is never resent.
    return recorded.error
      ? { adjustmentId: id, outcome: "record_failed", code: "record_failed" }
      : { adjustmentId: id, outcome, ...(code ? { code } : {}) }
  }
  const item = { customerId: c.stripe_customer_id, signedAmountCents: c.signed_amount_cents, identifier: c.provider_identifier }
  let ack: unknown
  try {
    ack = await runtime.provider.createPendingInvoiceItem(item)
  } catch (error) {
    const failure = classifyProviderFailure(error)
    return record(failure.outcome, failure.code)
  }
  const check = verifyInvoiceItemAck(ack, item)
  return check.ok ? record("applied", null) : record("unknown", check.code)
}

export async function applyApprovedAdjustments(
  serviceClient: SupabaseClient,
  runtime: AdjustmentRuntime,
  options: { limit?: number; shopId?: string; gate?: ItemGate } = {}
): Promise<{ ok: true; reports: AdjustmentReport[]; stoppedEarly?: true } | { ok: false; reason: "runtime_unavailable" | "worklist_failed" }> {
  if (!runtime.ok) return { ok: false, reason: "runtime_unavailable" }
  const listed = await serviceClient.rpc("commercial_adjustment_application_pending", { p_limit: options.limit ?? 50, p_shop: options.shopId ?? null })
  const parsed = adjustmentWorklist.safeParse(listed.data)
  if (listed.error || !parsed.success) return { ok: false, reason: "worklist_failed" }
  const reports: AdjustmentReport[] = []
  for (const item of parsed.data) {
    if (options.gate && !(await options.gate())) return { ok: true, reports, stoppedEarly: true }
    reports.push(await applyApprovedAdjustment(serviceClient, runtime, { shopId: item.shop_id, adjustmentId: item.adjustment_id }))
  }
  return { ok: true, reports }
}

export { ADJUSTMENT_DESCRIPTION }
