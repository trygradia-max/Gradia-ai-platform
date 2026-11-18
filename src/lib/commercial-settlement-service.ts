import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { FOUNDER_PILOT_POLICY, APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import {
  REVIEWED_SETTLEMENT_METER_MAPPING,
  buildDeliveryPlan,
  buildSettlementDocument,
  canonicalInstant,
  deriveDeliveryState,
  evaluateEligibility,
  settlementIdempotencyKey,
  validateMeterMapping,
  validateSettlementWindow,
  verifyMeterAck,
  type LineDeliveryStatus,
  type MeterMapping,
  type PlannedDelivery,
  type SettlementBlock,
  type SettlementDeliveryState,
  type SettlementDocument,
  type WindowIssue,
} from "@/lib/commercial-settlement"
import {
  classifyProviderFailure,
  createSettlementProvider,
  type SettlementProvider,
} from "@/lib/commercial-settlement-provider"
import { assembleCommercialPeriodPreview, parseMembershipRead } from "@/lib/commercial-usage-service"
import { resolveCommercialStripeConfig } from "@/lib/stripe-commercial"

/**
 * Server-side settlement orchestration (Commercial Billing PR D, sandbox only).
 *
 *  - READ/PREVIEW works with an owner SESSION client: the database re-derives live
 *    owner membership on every call, so a manager, staff, revoked, anonymous or
 *    cross-shop caller is refused.
 *  - WRITE/DELIVER requires a SERVICE-ROLE client, a shop the server derived, and a
 *    named actor whom the database re-verifies as a live owner of that exact shop.
 *  - The provider is a narrow boundary. A fake replaces it in every automated test.
 *  - An ambiguous provider result is recorded `unknown` and is NEVER retried here.
 *  - Nothing in this module marks an invoice paid or a subscription active.
 */

export type SettlementRuntime =
  | { ok: true; provider: SettlementProvider; mapping: MeterMapping }
  | {
      ok: false
      reason: "billing_unconfigured" | "billing_misconfigured" | "settlement_mapping_unprovisioned" | "settlement_mapping_invalid"
    }

/**
 * Disabled unless BOTH the sandbox Stripe configuration is complete and test-shaped
 * AND the reviewed event mapping has been provisioned. The mapping is code, never
 * environment: `REVIEWED_SETTLEMENT_METER_MAPPING` ships unprovisioned.
 */
export function resolveSettlementRuntime(
  env: Record<string, string | undefined> = process.env,
  mapping: MeterMapping = REVIEWED_SETTLEMENT_METER_MAPPING
): SettlementRuntime {
  const stripe = resolveCommercialStripeConfig(env)
  if (!stripe.ok) return stripe
  const validated = validateMeterMapping(mapping)
  if (!validated.ok) return validated
  return { ok: true, provider: createSettlementProvider(stripe.config), mapping: validated.mapping }
}

// ---------- evidence read ----------

const eligibilitySchema = z.object({
  window_closed: z.boolean(),
  subscription_period: z.object({ verified: z.boolean(), chain_complete: z.boolean() }).passthrough(),
  account_state: z.string().nullable().optional(),
  account_present: z.boolean(),
  catalog_version: z.string().nullable(),
  plan_key: z.string().nullable(),
  has_platform_customer: z.boolean(),
  overlapping_settlement_id: z.string().uuid().nullable(),
  existing_settlement_id: z.string().uuid().nullable(),
  existing_document_digest: z.string().nullable(),
  existing_evidence_digest: z.string().nullable(),
})
const evidenceSchema = z.object({
  as_of: z.string(),
  usage: z.unknown(),
  membership: z.unknown(),
  evidence_digest: z.string().regex(/^[0-9a-f]{64}$/),
  eligibility: eligibilitySchema,
})

type Window = { shopId: string; windowStart: string; windowEnd: string }

export type SettlementPreviewDelivery =
  | { state: "planned"; deliveries: PlannedDelivery[] }
  | {
      state: "blocked"
      reason: "settlement_mapping_unprovisioned" | "settlement_mapping_invalid" | "fractional_quantity_unsupported"
    }

export type CommercialSettlementPreview =
  | { status: "forbidden" }
  | { status: "unavailable"; reason: "invalid_window" | "read_failed" | "malformed_evidence" }
  | { status: "blocked"; blocks: SettlementBlock[]; detail?: string }
  | {
      status: "ready"
      asOf: string
      evidenceDigest: string
      documentDigest: string
      document: SettlementDocument
      delivery: SettlementPreviewDelivery
      /** True when this exact window was already settled (a replay would return it). */
      alreadySettled: boolean
    }

function windowArgs(w: Window) {
  return { p_shop: w.shopId, p_window_start: canonicalInstant(w.windowStart), p_window_end: canonicalInstant(w.windowEnd) }
}

type EvidenceRead =
  | { ok: false; result: Extract<CommercialSettlementPreview, { status: "forbidden" | "unavailable" | "blocked" }> }
  | {
      ok: true
      evidence: z.infer<typeof evidenceSchema>
      document: SettlementDocument
      documentDigest: string
    }

async function readAndBuild(client: SupabaseClient, w: Window): Promise<EvidenceRead> {
  const windowIssues = validateSettlementWindow(w.windowStart, w.windowEnd, Date.now())
  const structural = windowIssues.filter(
    (issue): issue is Exclude<WindowIssue, "window_not_closed"> => issue !== "window_not_closed"
  )
  if (structural.includes("window_not_utc_instant")) {
    return { ok: false, result: { status: "unavailable", reason: "invalid_window" } }
  }
  const { data, error } = await client.rpc("commercial_settlement_evidence", windowArgs(w))
  if (error) {
    return error.code === "42501"
      ? { ok: false, result: { status: "forbidden" } }
      : { ok: false, result: { status: "unavailable", reason: "read_failed" } }
  }
  const parsed = evidenceSchema.safeParse(data)
  if (!parsed.success) return { ok: false, result: { status: "unavailable", reason: "malformed_evidence" } }
  const evidence = parsed.data

  // The database's eligibility facts decide closedness (its clock), the pure checks add the rest.
  const blocks: SettlementBlock[] = [...new Set<SettlementBlock>([...structural, ...evaluateEligibility(evidence.eligibility)])]
  if (blocks.length > 0) return { ok: false, result: { status: "blocked", blocks } }

  const assembled = assembleCommercialPeriodPreview({
    usageRead: evidence.usage,
    membership: parseMembershipRead(evidence.membership),
    windowStart: canonicalInstant(w.windowStart),
    windowEnd: canonicalInstant(w.windowEnd),
  })
  if (!assembled.ok) return { ok: false, result: { status: "unavailable", reason: "malformed_evidence" } }
  const built = buildSettlementDocument(assembled.preview)
  if (!built.ok) return { ok: false, result: { status: "blocked", blocks: [built.block], detail: built.detail } }
  return { ok: true, evidence, document: built.document, documentDigest: built.digest }
}

function planDelivery(shopId: string, document: SettlementDocument, mapping: MeterMapping): SettlementPreviewDelivery {
  const validated = validateMeterMapping(mapping)
  if (!validated.ok) return { state: "blocked", reason: validated.reason }
  const plan = buildDeliveryPlan({ shopId, document, mapping: validated.mapping })
  return plan.ok ? { state: "planned", deliveries: plan.deliveries } : { state: "blocked", reason: plan.block }
}

/**
 * Invoice/settlement preview for one exact closed window. Read-only: no write, no
 * provider call. Works with an owner session. A window that is open, partial, not
 * covered by membership history, over the cap, or short of evidence is `blocked`
 * with the exact reason — never a zero.
 */
export async function previewCommercialSettlement(
  client: SupabaseClient,
  args: Window & { mapping?: MeterMapping }
): Promise<CommercialSettlementPreview> {
  const read = await readAndBuild(client, args)
  if (!read.ok) return read.result
  return {
    status: "ready",
    asOf: read.evidence.as_of,
    evidenceDigest: read.evidence.evidence_digest,
    documentDigest: read.documentDigest,
    document: read.document,
    delivery: planDelivery(args.shopId, read.document, args.mapping ?? REVIEWED_SETTLEMENT_METER_MAPPING),
    alreadySettled: read.evidence.eligibility.existing_settlement_id !== null,
  }
}

// ---------- settlement read ----------

const lineSchema = z.object({
  id: z.string().uuid(),
  component: z.string(),
  billed_quantity: z.string(),
  charge_cents: z.number().int(),
  value_basis: z.string().nullable(),
  event_value: z.string().nullable(),
  delivery_status: z.enum(["not_required", "pending", "in_flight", "delivered", "rejected", "unknown"]),
  failure_code: z.string().nullable(),
})
const settlementSchema = z.object({
  shop_id: z.string().uuid(),
  settlement: z
    .object({
      id: z.string().uuid(),
      catalog_version: z.string(),
      plan_key: z.string(),
      window_start: z.string(),
      window_end: z.string(),
      as_of: z.string(),
      evidence_digest: z.string(),
      document_digest: z.string(),
      base_cents: z.number().int(),
      seat_cents: z.number().int(),
      usage_cents: z.number().int(),
      usage_cap_cents: z.number().int(),
      total_cents: z.number().int(),
      mapping_version: z.string(),
      created_at: z.string(),
      lines: z.array(lineSchema),
    })
    .nullable(),
})

export type CommercialSettlementRead =
  | { status: "forbidden" }
  | { status: "unavailable"; reason: "invalid_window" | "read_failed" | "malformed_settlement" }
  | { status: "none" }
  | {
      status: "settled"
      settlement: NonNullable<z.infer<typeof settlementSchema>["settlement"]>
      /** Provider-side progress only. Never "paid"; never a subscription state. */
      delivery: SettlementDeliveryState
    }

export async function readCommercialSettlement(client: SupabaseClient, w: Window): Promise<CommercialSettlementRead> {
  if (validateSettlementWindow(w.windowStart, w.windowEnd, Number.MAX_SAFE_INTEGER).includes("window_not_utc_instant")) {
    return { status: "unavailable", reason: "invalid_window" }
  }
  const { data, error } = await client.rpc("commercial_settlement_read", windowArgs(w))
  if (error) {
    return error.code === "42501" ? { status: "forbidden" } : { status: "unavailable", reason: "read_failed" }
  }
  const parsed = settlementSchema.safeParse(data)
  if (!parsed.success) return { status: "unavailable", reason: "malformed_settlement" }
  if (!parsed.data.settlement) return { status: "none" }
  const statuses: LineDeliveryStatus[] = parsed.data.settlement.lines.map((line) => line.delivery_status)
  return { status: "settled", settlement: parsed.data.settlement, delivery: deriveDeliveryState(statuses) }
}

// ---------- settle + deliver ----------

export type SettleFailure =
  | "invalid"
  | "forbidden"
  | "not_settleable"
  | "conflict"
  | "failed"
  | "blocked"
  | "runtime_unavailable"

export type LineOutcome =
  | "delivered"
  | "already_delivered"
  | "not_required"
  | "rejected"
  | "unknown"
  | "in_progress"
  | "blocked"
  | "record_failed"

export type DeliveryReport = { component: string; outcome: LineOutcome; code?: string }

export type SettleResult =
  | {
      ok: true
      action: "created" | "replay"
      settlementId: string
      deliveries: DeliveryReport[]
      delivery: SettlementDeliveryState
    }
  | { ok: false; reason: SettleFailure; detail?: string; blocks?: SettlementBlock[] }

const beginSchema = z.object({
  action: z.enum(["created", "replay"]),
  settlement_id: z.string().uuid(),
  lines: z.array(z.object({ line_id: z.string().uuid(), component: z.string(), delivery_status: z.string() })),
})

function classify(error: { code?: string; message?: string }): { reason: SettleFailure; detail?: string } {
  switch (error.code) {
    case "42501":
      return { reason: "forbidden" }
    case "22023":
      return { reason: "invalid" }
    case "CB422":
      // The database names the exact refusal in its message; surface only that finite text.
      return { reason: "not_settleable", detail: error.message?.slice(0, 120) }
    case "CB409":
      return { reason: "conflict", detail: error.message?.slice(0, 120) }
    default:
      return { reason: "failed" }
  }
}

const claimSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("claimed"),
    claim_token: z.string().uuid(),
    component: z.string(),
    event_name: z.string(),
    event_value: z.string().regex(/^[1-9][0-9]*$/),
    provider_identifier: z.string(),
    event_timestamp: z.string(),
    stripe_customer_id: z.string(),
    value_basis: z.string(),
  }),
  z.object({ action: z.literal("in_progress") }),
  z.object({ action: z.literal("delivered") }),
  z.object({ action: z.literal("not_required") }),
  z.object({ action: z.literal("blocked"), status: z.string(), failure_code: z.string().nullable() }),
])

/**
 * Delivers every still-pending line of one settlement. Safe to call repeatedly: a
 * delivered line is skipped, an in-flight line is left alone, and a rejected or
 * unknown line is NEVER retried automatically (reconciliation owns it).
 */
export async function deliverCommercialSettlement(
  serviceClient: SupabaseClient,
  runtime: SettlementRuntime,
  args: { shopId: string; settlementId: string }
): Promise<{ ok: true; deliveries: DeliveryReport[]; delivery: SettlementDeliveryState } | { ok: false; reason: SettleFailure }> {
  if (!runtime.ok) return { ok: false, reason: "runtime_unavailable" }
  const lines = await serviceClient
    .from("commercial_settlement_lines")
    .select("id, component, delivery_status")
    .eq("shop_id", args.shopId)
    .eq("settlement_id", args.settlementId)
    .order("component")
  if (lines.error || !lines.data) return { ok: false, reason: "failed" }

  const reports: DeliveryReport[] = []
  for (const line of lines.data as { id: string; component: string; delivery_status: LineDeliveryStatus }[]) {
    const claimed = await serviceClient.rpc("commercial_settlement_delivery_claim", {
      p_shop: args.shopId,
      p_settlement: args.settlementId,
      p_line: line.id,
    })
    if (claimed.error) {
      reports.push({ component: line.component, outcome: "record_failed", code: classify(claimed.error).reason })
      continue
    }
    const claim = claimSchema.safeParse(claimed.data)
    if (!claim.success) {
      reports.push({ component: line.component, outcome: "record_failed", code: "malformed_claim" })
      continue
    }
    const c = claim.data
    if (c.action === "delivered") reports.push({ component: line.component, outcome: "already_delivered" })
    else if (c.action === "not_required") reports.push({ component: line.component, outcome: "not_required" })
    else if (c.action === "in_progress") reports.push({ component: line.component, outcome: "in_progress" })
    else if (c.action === "blocked") {
      reports.push({ component: line.component, outcome: "blocked", ...(c.failure_code ? { code: c.failure_code } : {}) })
    } else {
      const record = async (outcome: "delivered" | "rejected" | "unknown", code: string | null) => {
        const recorded = await serviceClient.rpc("commercial_settlement_delivery_record", {
          p_shop: args.shopId,
          p_settlement: args.settlementId,
          p_line: line.id,
          p_claim_token: c.claim_token,
          p_outcome: outcome,
          p_code: code,
        })
        // A failed record leaves the line in flight: the next claim marks it unknown. It is never re-sent.
        reports.push(
          recorded.error
            ? { component: line.component, outcome: "record_failed", code: classify(recorded.error).reason }
            : { component: line.component, outcome, ...(code ? { code } : {}) }
        )
      }
      // Send exactly what the database handed out for this claim.
      let ack: unknown
      try {
        ack = await runtime.provider.submitMeterEvent({
          eventName: c.event_name,
          customerId: c.stripe_customer_id,
          value: c.event_value,
          identifier: c.provider_identifier,
          timestampSeconds: Math.floor(Date.parse(c.event_timestamp) / 1000),
        })
      } catch (error) {
        const failure = classifyProviderFailure(error)
        await record(failure.outcome, failure.code)
        continue
      }
      const check = verifyMeterAck(ack, {
        eventName: c.event_name,
        customerId: c.stripe_customer_id,
        value: c.event_value,
        identifier: c.provider_identifier,
      })
      if (!check.ok) await record("unknown", check.code)
      else await record("delivered", null)
    }
  }

  const final = await serviceClient
    .from("commercial_settlement_lines")
    .select("delivery_status")
    .eq("shop_id", args.shopId)
    .eq("settlement_id", args.settlementId)
  if (final.error || !final.data) return { ok: false, reason: "failed" }
  return {
    ok: true,
    deliveries: reports,
    delivery: deriveDeliveryState((final.data as { delivery_status: LineDeliveryStatus }[]).map((row) => row.delivery_status)),
  }
}

const settleInput = z
  .object({
    shopId: z.string().uuid(),
    actorId: z.string().uuid(),
    windowStart: z.string(),
    windowEnd: z.string(),
    /**
     * Settle (immutable, replay-safe) but leave every delivery to the dispatcher worker
     * (`dispatchPendingSettlementDeliveries`). Same claim/record path; nothing is sent here.
     */
    deferDelivery: z.boolean().optional(),
  })
  .strict()

/**
 * Settles one exact closed window and hands its lines to the provider outbox.
 *
 * Order matters and is fail-closed at every step: reviewed mapping + sandbox
 * config → exact closed window → database eligibility + evidence → the one
 * reviewed preview (`ok` only) → immutable settlement (the database re-checks
 * authority, coverage, closedness and that the evidence is still exactly this
 * evidence) → deliveries. Replays return the original settlement; a changed
 * replay conflicts. This function never marks anything paid or active.
 */
export async function settleCommercialPeriod(
  serviceClient: SupabaseClient,
  runtime: SettlementRuntime,
  input: { shopId: string; actorId: string; windowStart: string; windowEnd: string; deferDelivery?: boolean }
): Promise<SettleResult> {
  const parsed = settleInput.safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid", detail: parsed.error.issues[0]?.message }
  if (!runtime.ok) return { ok: false, reason: "runtime_unavailable", detail: runtime.reason }
  const w: Window = parsed.data

  const read = await readAndBuild(serviceClient, w)
  if (!read.ok) {
    const r = read.result
    if (r.status === "forbidden") return { ok: false, reason: "forbidden" }
    if (r.status === "unavailable") return { ok: false, reason: r.reason === "invalid_window" ? "invalid" : "failed", detail: r.reason }
    return { ok: false, reason: "blocked", blocks: r.blocks, detail: r.detail }
  }
  const plan = planDelivery(w.shopId, read.document, runtime.mapping)
  if (plan.state === "blocked") {
    return { ok: false, reason: plan.reason === "fractional_quantity_unsupported" ? "blocked" : "runtime_unavailable", detail: plan.reason,
      ...(plan.reason === "fractional_quantity_unsupported" ? { blocks: ["fractional_quantity_unsupported" as const] } : {}) }
  }

  const begun = await serviceClient.rpc("commercial_settlement_begin", {
    p_shop: w.shopId,
    p_actor: parsed.data.actorId,
    p_catalog_version: APPROVED_COMMERCIAL_CATALOG_VERSION,
    p_plan_key: FOUNDER_PILOT_POLICY.planKey,
    p_window_start: canonicalInstant(w.windowStart),
    p_window_end: canonicalInstant(w.windowEnd),
    // Passed through unchanged: the database clock fixed this instant to the microsecond.
    p_as_of: read.evidence.as_of,
    p_evidence_digest: read.evidence.evidence_digest,
    p_document: read.document,
    p_document_digest: read.documentDigest,
    p_mapping_version: runtime.mapping.version,
    p_deliveries: plan.deliveries,
    p_idempotency_key: settlementIdempotencyKey(w.shopId, w.windowStart, w.windowEnd),
  })
  if (begun.error) return { ok: false, ...classify(begun.error) }
  const result = beginSchema.safeParse(begun.data)
  if (!result.success) return { ok: false, reason: "failed" }

  if (parsed.data.deferDelivery) {
    const statuses = await serviceClient
      .from("commercial_settlement_lines")
      .select("delivery_status")
      .eq("shop_id", w.shopId)
      .eq("settlement_id", result.data.settlement_id)
    if (statuses.error || !statuses.data) return { ok: false, reason: "failed" }
    return {
      ok: true,
      action: result.data.action,
      settlementId: result.data.settlement_id,
      deliveries: [],
      delivery: deriveDeliveryState((statuses.data as { delivery_status: LineDeliveryStatus }[]).map((row) => row.delivery_status)),
    }
  }

  const delivered = await deliverCommercialSettlement(serviceClient, runtime, {
    shopId: w.shopId,
    settlementId: result.data.settlement_id,
  })
  if (!delivered.ok) return { ok: false, reason: delivered.reason }
  return {
    ok: true,
    action: result.data.action,
    settlementId: result.data.settlement_id,
    deliveries: delivered.deliveries,
    delivery: delivered.delivery,
  }
}
