import { METRICS, METRIC_DEFINITION_VERSION, type MetricKey } from "./catalog"
import type {
  BaselineReadResult,
  ComparisonDto,
  ComparisonItem,
  DraftSummary,
  EvidenceClass,
  MeasurementRow,
  MetricInput,
  MetricItem,
  MetricReason,
  NotComparableReason,
  StartingPointDto,
} from "./dto"

/** Deterministic formulas only. No model output reaches any DTO. */
const rank: Record<EvidenceClass, number> = {
  unknown: 0, owner_estimate: 1, gradia_observed: 2, connected_evidence: 3, derived: 4,
}
const DAY = 86_400_000
const round2 = (n: number) => Math.round(n * 100) / 100
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

type Ctx = { revision: number; period: { start: string; end: string }; answers: Record<string, unknown> }

function blank(key: MetricKey, over: Partial<MetricItem> = {}): MetricItem {
  return {
    key, status: "not_measured", value: null, range: null, unit: null, evidenceClass: null,
    basisEvidenceClass: null, period: null, definitionVersion: METRIC_DEFINITION_VERSION,
    formulaVersion: null, inputs: [], sourceSystem: null, sourceRef: null, reason: null, ...over,
  }
}

type Read = { kind: "missing" } | { kind: "unknown" } | { kind: "range" } | { kind: "value"; value: number; unit: string }
function read(ctx: Ctx, key: string): Read {
  const a = ctx.answers[key]
  if (!isObj(a)) return { kind: "missing" }
  if (a.state === "unknown") return { kind: "unknown" }
  if (a.state === "range") return { kind: "range" }
  if (a.state === "value" && num(a.value) && typeof a.unit === "string") return { kind: "value", value: a.value, unit: a.unit }
  return { kind: "missing" }
}
const input = (ctx: Ctx, key: string): MetricInput => ({ kind: "answer", revision: ctx.revision, questionKey: key })
const period = (ctx: Ctx): MetricItem["period"] => ({ kind: "normal_period", ...ctx.period })

/** Single-answer pass-through (owner estimate, value or range or unknown). */
function passthrough(ctx: Ctx, key: MetricKey, q: string): MetricItem {
  const a = ctx.answers[q]
  const base = { inputs: [input(ctx, q)], period: period(ctx), evidenceClass: "owner_estimate" as const, basisEvidenceClass: "owner_estimate" as const }
  if (!isObj(a)) return blank(key, { reason: "input_missing" })
  if (a.state === "unknown") return blank(key, { ...base, status: "unknown", evidenceClass: "unknown", basisEvidenceClass: "unknown", reason: "input_unknown" })
  if (a.state === "range" && num(a.min) && num(a.max) && typeof a.unit === "string")
    return blank(key, { ...base, status: "measured", range: { min: a.min, max: a.max }, unit: a.unit })
  if (a.state === "value" && num(a.value) && typeof a.unit === "string")
    return blank(key, { ...base, status: "measured", value: a.value, unit: a.unit })
  return blank(key, { reason: "input_missing" })
}

function ratio(ctx: Ctx, key: MetricKey, formula: string, numKey: string, numUnit: string, denKey: string, denUnit: string): MetricItem {
  const inputs = [input(ctx, numKey), input(ctx, denKey)]
  const n = read(ctx, numKey), d = read(ctx, denKey)
  const kinds = [n.kind, d.kind]
  const fail = (status: MetricItem["status"], reason: MetricReason) =>
    blank(key, { status, reason, inputs, period: period(ctx), formulaVersion: formula,
      evidenceClass: status === "unknown" ? "unknown" : null, basisEvidenceClass: status === "unknown" ? "unknown" : null })
  if (kinds.includes("unknown")) return fail("unknown", "input_unknown")
  if (kinds.includes("missing")) return fail("not_measured", "input_missing")
  if (kinds.includes("range")) return fail("not_measured", "input_is_range")
  if (n.kind !== "value" || d.kind !== "value" || n.unit !== numUnit || d.unit !== denUnit) return fail("not_measured", "input_missing")
  if (d.value === 0) return fail("not_measured", "zero_denominator")
  if (n.value > d.value) return fail("not_measured", "inconsistent_inputs")
  return blank(key, {
    status: "measured", value: round2((n.value / d.value) * 100), unit: "percent", evidenceClass: "derived",
    basisEvidenceClass: "owner_estimate", period: period(ctx), formulaVersion: formula, inputs,
  })
}

/** Percent answer passes through; a count answer becomes a derived share of monthly inquiries. */
function shareOfInquiries(ctx: Ctx, key: MetricKey, formula: string, q: string): MetricItem {
  const a = read(ctx, q)
  if (a.kind === "value" && a.unit === "percent") return passthrough(ctx, key, q)
  if (a.kind === "missing" || a.kind === "unknown") return passthrough(ctx, key, q)
  return ratio(ctx, key, formula, q, "count_per_month", "inquiries_per_month", "count_per_month")
}

function adminHours(ctx: Ctx): MetricItem {
  const keys = ["admin_hours_calls", "admin_hours_follow_up", "admin_hours_crm", "admin_hours_scheduling"]
  const inputs = keys.map((k) => input(ctx, k))
  const reads = keys.map((k) => read(ctx, k))
  const common = { inputs, period: period(ctx), formulaVersion: "admin_hours.v1" }
  if (reads.some((r) => r.kind === "unknown"))
    return blank("admin_hours", { ...common, status: "unknown", evidenceClass: "unknown", basisEvidenceClass: "unknown", reason: "input_unknown" })
  if (reads.some((r) => r.kind !== "value"))
    return blank("admin_hours", { ...common, reason: "input_missing" })
  const total = reads.reduce((s, r) => s + (r.kind === "value" ? r.value : 0), 0)
  return blank("admin_hours", { ...common, status: "measured", value: round2(total), unit: "hours_per_week", evidenceClass: "derived", basisEvidenceClass: "owner_estimate" })
}

function fromMeasurement(m: MeasurementRow, attached: Map<string, MeasurementRow>): MetricItem {
  const key = m.metric_key as MetricKey
  const inputs: MetricInput[] = m.inputs.map((i) => ({ kind: "measurement", measurementId: i.measurement_id }))
  let basis: EvidenceClass | null = m.evidence_class === "derived" ? null : m.evidence_class
  if (m.evidence_class === "derived") {
    const found = m.inputs.map((i) => attached.get(i.measurement_id))
    if (found.every(Boolean))
      basis = found.reduce<EvidenceClass>((w, r) => (rank[r!.evidence_class] < rank[w] ? r!.evidence_class : w), "connected_evidence")
  }
  return {
    key, status: m.value === null ? "unknown" : "measured", value: m.value, range: null, unit: m.unit,
    evidenceClass: m.evidence_class, basisEvidenceClass: basis,
    period: { kind: "window", start: m.window_start, end: m.window_end },
    definitionVersion: m.definition_version, formulaVersion: m.formula_version, inputs,
    sourceSystem: m.source_system, sourceRef: m.source_ref, reason: m.value === null ? "input_unknown" : null,
  }
}

const SECTION_KEYS = {
  response: ["inquiry_volume", "missed_call_rate", "first_response_minutes"],
  booking: ["booking_rate", "cancellations_no_shows"],
  followUp: ["followup_coverage", "unresolved_leads"],
  operatingLoad: ["admin_hours"],
} as const satisfies Record<string, readonly MetricKey[]>

function ownerMetric(ctx: Ctx, key: MetricKey): MetricItem {
  switch (key) {
    case "inquiry_volume": return passthrough(ctx, key, "inquiries_per_month")
    case "missed_call_rate": return ratio(ctx, key, "missed_call_rate.v1", "missed_calls_per_week", "count_per_week", "calls_per_week", "count_per_week")
    case "first_response_minutes": return passthrough(ctx, key, "first_response_minutes")
    case "booking_rate": return shareOfInquiries(ctx, key, "booking_rate.v1", "confirmed_bookings")
    case "cancellations_no_shows": return passthrough(ctx, key, "cancellations_no_shows_per_month")
    case "followup_coverage": return shareOfInquiries(ctx, key, "followup_coverage.v1", "followed_up_within_two_days")
    case "unresolved_leads": return blank(key, { reason: "input_missing" }) // no honest owner-answer derivation
    case "admin_hours": return adminHours(ctx)
  }
}

export function summarizeDraft(d: NonNullable<BaselineReadResult["draft"]>): DraftSummary {
  return { draftVersion: d.draft_version, catalogVersion: d.catalog_version, updatedByRole: d.updated_by_role, updatedAt: d.updated_at, answers: d.answers }
}

/** Metric items for one revision: attached connected/observed evidence wins over owner answers. */
export function metricsForRevision(read_: BaselineReadResult): Map<MetricKey, MetricItem> {
  const rev = read_.revision!
  const ctx: Ctx = { revision: rev.revision, period: { start: rev.reporting_period_start, end: rev.reporting_period_end }, answers: rev.answers }
  const attached = new Map(read_.measurements.map((m) => [m.id, m]))
  const byMetric = new Map(read_.measurements.map((m) => [m.metric_key, m]))
  const out = new Map<MetricKey, MetricItem>()
  for (const key of Object.keys(METRICS) as MetricKey[]) {
    const m = byMetric.get(key)
    out.set(key, m ? fromMeasurement(m, attached) : ownerMetric(ctx, key))
  }
  return out
}

function choice(answers: Record<string, unknown>, key: string): string | "unknown" | null {
  const a = answers[key]
  if (!isObj(a)) return null
  return a.state === "unknown" ? "unknown" : typeof a.value === "string" ? a.value : null
}

export function buildStartingPoint(r: BaselineReadResult): StartingPointDto {
  const draft = r.draft ? summarizeDraft(r.draft) : null
  if (!r.revision) return { status: "not_started", role: r.role, draft }
  const metrics = metricsForRevision(r)
  const pick = (keys: readonly MetricKey[]) => keys.map((k) => metrics.get(k)!)
  const a = r.revision.answers
  const channels = isObj(a.active_channels)
    ? a.active_channels.state === "unknown" ? "unknown" : Array.isArray(a.active_channels.value) ? (a.active_channels.value as string[]) : null
    : null
  const goal = (k: string) => { const c = choice(a, k); return c === "unknown" ? null : c }
  const note = isObj(a.pilot_goal_note) && typeof a.pilot_goal_note.value === "string" ? a.pilot_goal_note.value : null
  return {
    status: "ready", role: r.role, catalogVersion: r.revision.catalog_version, revision: r.revision.revision,
    supersedesRevision: r.revision.supersedes_revision, submittedAt: r.revision.submitted_at,
    reportingPeriod: { start: r.revision.reporting_period_start, end: r.revision.reporting_period_end },
    sections: {
      response: pick(SECTION_KEYS.response), booking: pick(SECTION_KEYS.booking),
      followUp: pick(SECTION_KEYS.followUp), operatingLoad: pick(SECTION_KEYS.operatingLoad),
    },
    readiness: { recordsSystem: choice(a, "records_system"), calendarSystem: choice(a, "calendar_system"), activeChannels: channels },
    goal: { primary: goal("pilot_primary_outcome"), secondary: goal("pilot_secondary_outcome"), note },
    draft,
  }
}

const durationMs = (p: NonNullable<MetricItem["period"]>) => Date.parse(p.end) - Date.parse(p.start)

/** Like-for-like only. Never a percentage improvement, savings or ROI. */
export function buildComparison(r: BaselineReadResult, windowRows: MeasurementRow[], window: { start: string; end: string }): ComparisonDto {
  if (!r.revision) return { status: "not_started" }
  const baseline = metricsForRevision(r)
  const attached = new Map(windowRows.map((m) => [m.id, m]))
  const items: ComparisonItem[] = []
  for (const key of Object.keys(METRICS) as MetricKey[]) {
    const b = baseline.get(key)!
    const candidates = windowRows.filter((m) => m.metric_key === key)
    const nc = (reason: NotComparableReason, cur: MetricItem | null = null): ComparisonItem =>
      ({ key, status: "not_comparable", reason, baseline: b.status === "not_measured" ? null : b, current: cur })
    if (!candidates.length) { items.push(nc("current_not_measured")); continue }
    // Prefer the candidate matching the baseline's own evidence class/source; otherwise require one.
    let chosen = candidates.find((m) => m.evidence_class === b.evidenceClass && m.source_system === b.sourceSystem && m.source_ref === b.sourceRef)
    if (!chosen && candidates.length === 1) chosen = candidates[0]
    if (!chosen) { items.push(nc("ambiguous_current_evidence")); continue }
    const cur = fromMeasurement(chosen, attached)
    if (b.status === "not_measured") { items.push(nc("baseline_not_measured", cur)); continue }
    if (b.status === "unknown") { items.push(nc("baseline_unknown", cur)); continue }
    if (cur.status === "unknown") { items.push(nc("current_unknown", cur)); continue }
    if (b.range) { items.push(nc("baseline_is_range", cur)); continue }
    // Owner answers describe a "normal period", not an observation window: reference only.
    if (b.period?.kind === "normal_period" || b.basisEvidenceClass === "owner_estimate") {
      items.push({ key, status: "reference_only", baseline: b, current: cur }); continue
    }
    if (b.definitionVersion !== cur.definitionVersion || b.formulaVersion !== cur.formulaVersion) { items.push(nc("definition_changed", cur)); continue }
    if (b.unit !== cur.unit) { items.push(nc("unit_changed", cur)); continue }
    const bp = b.period!, cp = cur.period!
    if (Date.parse(cp.start) < Date.parse(bp.end)) { items.push(nc("windows_overlap", cur)); continue }
    const bl = durationMs(bp), cl = durationMs(cp)
    if (METRICS[key].windowSensitive) {
      if (Math.round(bl / DAY) !== Math.round(cl / DAY)) { items.push(nc("window_length_differs", cur)); continue }
    } else if (bl < 7 * DAY || cl < 7 * DAY) { items.push(nc("window_too_short", cur)); continue }
    items.push({ key, status: "comparable", baseline: b, current: cur, delta: round2(cur.value! - b.value!) })
  }
  return { status: "ready", baselineRevision: r.revision.revision, window, items }
}
