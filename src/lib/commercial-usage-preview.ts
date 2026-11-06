import { APPROVED_COMMERCIAL_CATALOG_VERSION } from "@/lib/approved-commercial-catalog"
import type { CommercialCatalog, CommercialPlan } from "@/lib/commercial-pricing"
import {
  computeSeatProration,
  type MembershipEvidence,
  type MembershipEvidenceUnavailable,
  type SeatProration,
} from "@/lib/commercial-seat-proration"
import {
  COMMERCIAL_METRICS,
  OUTCOME_RANK,
  isCommercialMetric,
  isOutcomeMetric,
  type CommercialMetric,
  type OutcomeMetric,
} from "@/lib/commercial-usage"

/**
 * Deterministic commercial period preview. Pure: no clock, no network, no
 * Stripe, no invoice. Same inputs always produce the same output.
 *
 * All quantity and money arithmetic uses scaled integers (10^-6) so included
 * allowances, markup floors and the cap are exact — never floating point.
 *
 * Failure is never zero. Unavailable, invalid and conflict states carry no
 * charge totals at all, so a caller cannot render them as "$0".
 */

const SCALE = BigInt(1_000_000)
const SCALE2 = SCALE * SCALE
const DECIMAL = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/
const MAX_WINDOW_MS = 40 * 24 * 60 * 60 * 1000

export type EvidenceFact = {
  id: string
  catalogVersion: string
  metric: string
  quantity: string
  workflowKey: string | null
  wholesaleUnitCostCents: string | null
  wholesaleBasis: string | null
  recognizedAt: string
  recordedAt: string
}

export type EvidenceCorrection = {
  id: string
  recognitionId: string
  quantity: string
  reason: string
  recordedAt: string
}

export type PreviewInput = {
  catalog: CommercialCatalog
  planKey: string
  /** Half-open UTC window [windowStart, windowEnd). */
  windowStart: string
  windowEnd: string
  /** Only facts/corrections recorded at or before this instant are considered. */
  asOf: string
  facts: readonly EvidenceFact[]
  corrections: readonly EvidenceCorrection[]
  /** workflow key -> highest surviving outcome metric recognized in an EARLIER window. */
  priorWorkflowMetrics: Readonly<Record<string, string>>
  /**
   * Immutable membership billing evidence for the same window (PR B). Absent or
   * unavailable evidence leaves seat proration `seat_proration_unavailable`; it
   * never changes the usage calculation.
   */
  membership?: MembershipEvidence | MembershipEvidenceUnavailable
}

export type UsageLine = {
  metric: CommercialMetric
  includedQuantity: string
  recognizedQuantity: string
  billedQuantity: string
  chargeCents: number
  evidence: {
    factId: string
    recognizedAt: string
    quantity: string
    coveredByAllowance: string
    billedQuantity: string
    /** Retail price per unit in cents, exact decimal. "0" for allowance-only facts. */
    retailUnitCents: string
    wholesaleBasis: string | null
  }[]
}

export type ExcludedEvidence = {
  factId: string
  workflowKey: string | null
  reason:
    | "fully_corrected"
    | "lower_value_same_workflow"
    | "duplicate_same_metric"
    | "already_recognized_earlier_period"
}

export type SubscriptionView = {
  planKey: string
  baseCents: number
  includedSeats: number
  extraSeatCents: number
  /** Computed only from complete recorded membership coverage; otherwise unavailable with the gap. */
  seatProration: SeatProration
  /**
   * Available only when EVERY component is: base, seat proration and usage. Any
   * unavailable, conflicted or cap-refused component keeps the total unavailable.
   */
  invoiceTotal: InvoiceTotalView
}

export type InvoiceTotalView =
  | {
      state: "unavailable"
      reason:
        | "seat_proration_unavailable"
        | "usage_unavailable"
        | "usage_conflict"
        | "usage_cap_exceeded"
    }
  | {
      state: "available"
      baseCents: number
      seatCents: number
      usageCents: number
      totalCents: number
    }

type Header = {
  catalogVersion: string
  currency: "usd"
  window: { start: string; end: string }
  asOf: string
}

export type UnavailableReason =
  | { code: "wholesale_evidence_missing"; factId: string; metric: CommercialMetric }
  | { code: "payg_disabled" | "payg_mode_unsupported"; metric: CommercialMetric }

export type PreviewConflict =
  | { code: "over_corrected"; factId: string }
  | { code: "workflow_spans_periods"; workflowKey: string; priorMetric: string; windowMetric: string }

export type CommercialPeriodPreview =
  | (Header & {
      state: "ok"
      subscription: SubscriptionView
      usage: {
        totalCents: number
        capCents: number
        lines: UsageLine[]
        excluded: ExcludedEvidence[]
      }
    })
  | (Header & {
      state: "cap_exceeded"
      subscription: SubscriptionView
      /** Nothing is charged: a single combined cap refuses the whole usage preview. */
      usage: { projectedCents: number; capCents: number; lines: UsageLine[] }
    })
  | (Header & {
      state: "unavailable"
      subscription: SubscriptionView
      reasons: UnavailableReason[]
    })
  | (Header & {
      state: "conflict"
      subscription: SubscriptionView
      conflicts: PreviewConflict[]
    })
  | { state: "invalid"; issues: string[] }

// --- exact decimal helpers -------------------------------------------------

function parseScaled(value: string): bigint | null {
  if (!DECIMAL.test(value)) return null
  const [whole, frac = ""] = value.split(".")
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(6, "0"))
}

function numberToScaled(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0) return null
  return BigInt(Math.round(value * 1_000_000))
}

function formatScaled(value: bigint): string {
  const whole = value / SCALE
  const frac = (value % SCALE).toString().padStart(6, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : `${whole}`
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - BigInt(1)) / denominator
}

function parseUtc(value: string): number | null {
  if (!/(?:Z|[+-]00:?00)$/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

const subscriptionView = (
  plan: CommercialPlan,
  seatProration: SeatProration,
  invoiceTotal: InvoiceTotalView
): SubscriptionView => ({
  planKey: plan.key,
  baseCents: plan.monthlyBaseCents,
  includedSeats: plan.includedSeats,
  extraSeatCents: plan.extraSeatCents,
  seatProration,
  invoiceTotal,
})

type Counted = {
  id: string
  recognizedAtMs: number
  recognizedAt: string
  quantity: bigint
  unitCost: bigint | null
  basis: string | null
}

const byTimeThenId = (a: Counted, b: Counted) =>
  a.recognizedAtMs - b.recognizedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function previewCommercialPeriod(input: PreviewInput): CommercialPeriodPreview {
  const issues: string[] = []

  const startMs = parseUtc(input.windowStart)
  const endMs = parseUtc(input.windowEnd)
  const asOfMs = parseUtc(input.asOf)
  if (startMs === null || endMs === null || asOfMs === null) {
    return { state: "invalid", issues: ["window and asOf must be ISO-8601 UTC instants"] }
  }
  if (endMs <= startMs) issues.push("window end must be after window start")
  if (endMs - startMs > MAX_WINDOW_MS) issues.push("window is longer than a billing month")

  const plan = input.catalog.plans.find((candidate) => candidate.key === input.planKey)
  if (!plan) return { state: "invalid", issues: [...issues, `unknown plan: ${input.planKey}`] }

  const rateMetrics = plan.payg.rates.map((rate) => rate.metric)
  if (
    rateMetrics.length !== COMMERCIAL_METRICS.length ||
    !COMMERCIAL_METRICS.every((metric) => rateMetrics.includes(metric))
  ) {
    issues.push("plan rates do not exactly match the approved commercial metrics")
  }

  // --- validate every supplied fact; unknown kinds fail closed ----------------
  const seenIds = new Set<string>()
  type Parsed = Counted & { metric: CommercialMetric; workflowKey: string | null }
  const parsed: Parsed[] = []
  for (const fact of input.facts) {
    if (seenIds.has(fact.id)) issues.push(`duplicate fact id: ${fact.id}`)
    seenIds.add(fact.id)
    if (fact.catalogVersion !== APPROVED_COMMERCIAL_CATALOG_VERSION) {
      issues.push(`fact ${fact.id}: unapproved catalog version ${fact.catalogVersion}`)
      continue
    }
    if (!isCommercialMetric(fact.metric)) {
      issues.push(`fact ${fact.id}: unknown metric ${fact.metric}`)
      continue
    }
    const quantity = parseScaled(fact.quantity)
    const recognizedAtMs = parseUtc(fact.recognizedAt)
    const recordedAtMs = parseUtc(fact.recordedAt)
    if (quantity === null || quantity <= BigInt(0) || recognizedAtMs === null || recordedAtMs === null) {
      issues.push(`fact ${fact.id}: malformed quantity or time`)
      continue
    }
    let unitCost: bigint | null = null
    if (fact.wholesaleUnitCostCents !== null) {
      unitCost = parseScaled(fact.wholesaleUnitCostCents)
      if (unitCost === null || fact.wholesaleBasis === null) {
        issues.push(`fact ${fact.id}: malformed wholesale evidence`)
        continue
      }
    }
    if (isOutcomeMetric(fact.metric)) {
      if (!fact.workflowKey) {
        issues.push(`fact ${fact.id}: outcome without workflow identity`)
        continue
      }
      if (quantity !== SCALE) {
        issues.push(`fact ${fact.id}: outcome quantity must be exactly 1`)
        continue
      }
    }
    // Half-open window and as-of are applied here as well as in the database.
    if (recognizedAtMs < startMs || recognizedAtMs >= endMs || recordedAtMs > asOfMs) continue
    parsed.push({
      id: fact.id,
      metric: fact.metric,
      workflowKey: fact.workflowKey,
      recognizedAt: new Date(recognizedAtMs).toISOString(),
      recognizedAtMs,
      quantity,
      unitCost,
      basis: fact.wholesaleBasis,
    })
  }

  for (const [workflowKey, metric] of Object.entries(input.priorWorkflowMetrics)) {
    if (!isOutcomeMetric(metric)) issues.push(`prior workflow ${workflowKey}: not an outcome metric`)
  }
  const corrections = new Map<string, bigint>()
  for (const correction of input.corrections) {
    const quantity = parseScaled(correction.quantity)
    const recordedAtMs = parseUtc(correction.recordedAt)
    if (quantity === null || quantity <= BigInt(0) || recordedAtMs === null) {
      issues.push(`correction ${correction.id}: malformed quantity or time`)
      continue
    }
    if (recordedAtMs > asOfMs) continue
    corrections.set(
      correction.recognitionId,
      (corrections.get(correction.recognitionId) ?? BigInt(0)) + quantity
    )
  }
  if (issues.length > 0) return { state: "invalid", issues }
  // Canonical order: output must not depend on the order evidence was supplied.
  parsed.sort(byTimeThenId)

  const header: Header = {
    catalogVersion: APPROVED_COMMERCIAL_CATALOG_VERSION,
    currency: "usd",
    window: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    },
    asOf: new Date(asOfMs).toISOString(),
  }
  // Seat proration is independent of usage: its failure never alters usage lines.
  const seat = computeSeatProration({
    includedSeats: plan.includedSeats,
    extraSeatCents: plan.extraSeatCents,
    periodStart: header.window.start,
    periodEnd: header.window.end,
    asOf: header.asOf,
    evidence: input.membership,
  })
  const seatBlocked: InvoiceTotalView | null =
    seat.state === "computed" ? null : { state: "unavailable", reason: "seat_proration_unavailable" }
  const withInvoice = (blocked: InvoiceTotalView | null) =>
    subscriptionView(plan, seat, blocked ?? seatBlocked ?? { state: "unavailable", reason: "usage_unavailable" })
  const subscription = withInvoice({ state: "unavailable", reason: "usage_unavailable" })

  // --- net quantities after compensating corrections --------------------------
  const conflicts: PreviewConflict[] = []
  const excluded: ExcludedEvidence[] = []
  const live: Parsed[] = []
  for (const fact of parsed) {
    const corrected = corrections.get(fact.id) ?? BigInt(0)
    if (corrected > fact.quantity) {
      conflicts.push({ code: "over_corrected", factId: fact.id })
      continue
    }
    const net = fact.quantity - corrected
    if (net === BigInt(0)) {
      excluded.push({ factId: fact.id, workflowKey: fact.workflowKey, reason: "fully_corrected" })
      continue
    }
    live.push({ ...fact, quantity: net })
  }

  // --- highest-value-only digital outcome per workflow, order independent ------
  const workflows = new Map<string, Parsed[]>()
  const counted = new Map<CommercialMetric, Counted[]>(COMMERCIAL_METRICS.map((metric) => [metric, []]))
  for (const fact of live) {
    if (isOutcomeMetric(fact.metric)) {
      const group = workflows.get(fact.workflowKey as string) ?? []
      group.push(fact)
      workflows.set(fact.workflowKey as string, group)
    } else {
      counted.get(fact.metric)?.push(fact)
    }
  }
  for (const [workflowKey, group] of [...workflows.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const winnerMetric = group
      .map((fact) => fact.metric as OutcomeMetric)
      .reduce((best, metric) => (OUTCOME_RANK[metric] > OUTCOME_RANK[best] ? metric : best))
    const prior = input.priorWorkflowMetrics[workflowKey] as OutcomeMetric | undefined
    if (prior) {
      if (OUTCOME_RANK[prior] >= OUTCOME_RANK[winnerMetric]) {
        for (const fact of group) {
          excluded.push({ factId: fact.id, workflowKey, reason: "already_recognized_earlier_period" })
        }
        continue
      }
      conflicts.push({
        code: "workflow_spans_periods",
        workflowKey,
        priorMetric: prior,
        windowMetric: winnerMetric,
      })
      continue
    }
    const winners = group.filter((fact) => fact.metric === winnerMetric).sort(byTimeThenId)
    counted.get(winnerMetric)?.push(winners[0])
    for (const fact of winners.slice(1)) {
      excluded.push({ factId: fact.id, workflowKey, reason: "duplicate_same_metric" })
    }
    for (const fact of group.filter((candidate) => candidate.metric !== winnerMetric)) {
      excluded.push({ factId: fact.id, workflowKey, reason: "lower_value_same_workflow" })
    }
  }
  if (conflicts.length > 0) {
    return {
      ...header,
      state: "conflict",
      subscription: withInvoice({ state: "unavailable", reason: "usage_conflict" }),
      conflicts,
    }
  }

  // --- allowances, fixed rates and dynamic markup floors -----------------------
  const unavailable: UnavailableReason[] = []
  const lines: UsageLine[] = []
  let totalCents = 0
  for (const metric of COMMERCIAL_METRICS) {
    const rate = plan.payg.rates.find((candidate) => candidate.metric === metric)
    if (!rate) continue // unreachable: validated above
    const included = numberToScaled(rate.includedQuantity)
    const items = (counted.get(metric) ?? []).sort(byTimeThenId)
    if (included === null) return { state: "invalid", issues: [`invalid allowance for ${metric}`] }

    let remaining = included
    let recognized = BigInt(0)
    let billedTotal = BigInt(0)
    let accumulator = BigInt(0)
    const evidence: UsageLine["evidence"] = []
    for (const item of items) {
      recognized += item.quantity
      const covered = item.quantity < remaining ? item.quantity : remaining
      remaining -= covered
      const billed = item.quantity - covered
      let retailUnit = BigInt(0)
      if (billed > BigInt(0)) {
        if (plan.payg.mode !== "postpaid") {
          unavailable.push({
            code: plan.payg.mode === "disabled" ? "payg_disabled" : "payg_mode_unsupported",
            metric,
          })
          continue
        }
        if (rate.pricing.kind === "fixed") {
          retailUnit = numberToScaled(rate.pricing.retailUnitCents) ?? BigInt(0)
        } else {
          if (item.unitCost === null) {
            // Unknown wholesale evidence is never silently zero.
            unavailable.push({ code: "wholesale_evidence_missing", factId: item.id, metric })
            continue
          }
          const floor = numberToScaled(rate.pricing.minimumRetailUnitCents) ?? BigInt(0)
          const marked = ceilDiv(item.unitCost * BigInt(rate.pricing.multiplierBps), BigInt(10_000))
          retailUnit = marked > floor ? marked : floor
        }
        accumulator += retailUnit * billed
        billedTotal += billed
      }
      evidence.push({
        factId: item.id,
        recognizedAt: item.recognizedAt,
        quantity: formatScaled(item.quantity),
        coveredByAllowance: formatScaled(covered),
        billedQuantity: formatScaled(billed),
        retailUnitCents: formatScaled(retailUnit),
        wholesaleBasis: item.basis,
      })
    }
    const chargeCents = Number(ceilDiv(accumulator, SCALE2))
    totalCents += chargeCents
    lines.push({
      metric,
      includedQuantity: formatScaled(included),
      recognizedQuantity: formatScaled(recognized),
      billedQuantity: formatScaled(billedTotal),
      chargeCents,
      evidence,
    })
  }
  if (unavailable.length > 0) {
    return { ...header, state: "unavailable", subscription, reasons: unavailable }
  }

  // One combined monthly cap across every metric; no partial hidden charging.
  const capCents = plan.payg.monthlyCapCents
  if (capCents === null) {
    return {
      ...header,
      state: "unavailable",
      subscription,
      reasons: COMMERCIAL_METRICS.map((metric) => ({ code: "payg_mode_unsupported" as const, metric })),
    }
  }
  if (totalCents > capCents) {
    return {
      ...header,
      state: "cap_exceeded",
      subscription: withInvoice({ state: "unavailable", reason: "usage_cap_exceeded" }),
      usage: { projectedCents: totalCents, capCents, lines },
    }
  }
  const invoiceTotal: InvoiceTotalView =
    seat.state === "computed"
      ? {
          state: "available",
          baseCents: plan.monthlyBaseCents,
          seatCents: seat.roundedCents,
          usageCents: totalCents,
          totalCents: plan.monthlyBaseCents + seat.roundedCents + totalCents,
        }
      : { state: "unavailable", reason: "seat_proration_unavailable" }
  return {
    ...header,
    state: "ok",
    subscription: subscriptionView(plan, seat, invoiceTotal),
    usage: { totalCents, capCents, lines, excluded },
  }
}
