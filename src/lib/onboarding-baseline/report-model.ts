import type { MetricKey } from "./catalog"
import type { EvidenceClass, MetricItem, StartingPointDto } from "./dto"
import { EVIDENCE_LABELS, METRIC_LABELS, NOT_MEASURED_REASONS, OUTCOME_LABELS, READINESS_LABELS, SECTION_REPORT_COPY, STATE_LABELS } from "./copy"
import { formatDate, formatDateRange, formatRange, formatUnitValue } from "./format"

/**
 * Presentation model for the Starting point report. It only re-labels the server DTO: it never computes,
 * rounds, fills or upgrades a value, and it never derives a delta, a saving or a percentage improvement.
 * What it adds is wording: every figure carries its evidence label and period, `unknown` and
 * `not measured` read as what they are, and a failed read never reaches this file (callers render a
 * written state for `unavailable` / `forbidden` instead).
 */

export type EvidenceKind = "owner" | "connected" | "observed" | "unsure" | "calculated" | "none"
export type MetricView = {
  key: MetricKey
  title: string
  help: string
  state: "value" | "range" | "unknown" | "not_measured"
  /** "Not sure" or "Not measured yet" where there is no figure; null when there is one. */
  stateLabel: string | null
  /** The figure itself, or null when there is none. Never "0" standing in for missing. */
  valueText: string | null
  evidence: { kind: EvidenceKind; label: string; detail: string } | null
  periodText: string | null
  /** Why there is no figure (unknown / not measured), in plain words. */
  reasonText: string | null
  /** How a calculated figure was worked out; null for a plain answer or measurement. */
  methodText: string | null
  /** Exact-source detail for the "how this was worked out" disclosure. */
  details: string[]
}

const KIND: Record<Exclude<EvidenceClass, "derived">, EvidenceKind> = {
  owner_estimate: "owner",
  connected_evidence: "connected",
  gradia_observed: "observed",
  unknown: "unsure",
}

function evidenceFor(item: MetricItem): MetricView["evidence"] {
  if (item.status === "not_measured" || !item.evidenceClass) return null
  // A calculated figure is labelled by the weakest evidence behind it (what the owner can rely on).
  const cls = item.evidenceClass === "derived" ? item.basisEvidenceClass : item.evidenceClass
  if (!cls || cls === "derived") return { kind: "calculated", label: "Calculated", detail: "Worked out by Gradia from recorded evidence. The inputs are listed below." }
  const e = EVIDENCE_LABELS[cls]
  return { kind: KIND[cls], label: e.label, detail: e.detail }
}

function periodFor(item: MetricItem): string | null {
  if (!item.period) return null
  return item.period.kind === "normal_period"
    ? `Your normal period, estimated for ${formatDateRange(item.period.start, item.period.end)}`
    : `Measured ${formatDateRange(item.period.start, item.period.end)}`
}

export function describeMetric(item: MetricItem): MetricView {
  const label = METRIC_LABELS[item.key]
  const base = { key: item.key, title: label.title, help: label.help, evidence: evidenceFor(item), periodText: periodFor(item) }
  const calculated = item.evidenceClass === "derived"
  const methodText = calculated
    ? item.inputs.every((i) => i.kind === "answer")
      ? "Calculated by Gradia from your answers."
      : "Calculated by Gradia from recorded measurements."
    : null
  const details: string[] = [`Definition ${item.definitionVersion}`]
  if (item.formulaVersion) details.push(`Formula ${item.formulaVersion}`)
  if (item.inputs.length) details.push(`${item.inputs.length} ${item.inputs.length === 1 ? "input" : "inputs"}`)
  if (item.sourceSystem) details.push(`Source: ${item.sourceSystem}`)
  if (item.sourceRef) details.push(`Reference: ${item.sourceRef}`)

  if (item.status === "unknown")
    return { ...base, state: "unknown", stateLabel: STATE_LABELS.unknown, valueText: null, reasonText: NOT_MEASURED_REASONS[item.reason ?? "input_unknown"], methodText, details }
  if (item.status === "not_measured")
    return { ...base, state: "not_measured", stateLabel: STATE_LABELS.not_measured, valueText: null, reasonText: NOT_MEASURED_REASONS[item.reason ?? "input_missing"], methodText, details }
  if (item.range)
    return { ...base, state: "range", stateLabel: null, valueText: formatRange(item.range.min, item.range.max, item.unit), reasonText: null, methodText, details }
  if (item.value === null)
    // A "measured" item with no value is a contract violation; show nothing rather than a zero.
    return { ...base, state: "not_measured", stateLabel: STATE_LABELS.not_measured, valueText: null, reasonText: NOT_MEASURED_REASONS.input_missing, methodText, details }
  return { ...base, state: "value", stateLabel: null, valueText: formatUnitValue(item.value, item.unit), reasonText: null, methodText, details }
}

type Ready = Extract<StartingPointDto, { status: "ready" }>
export type ReportView = {
  revision: number
  replacesRevision: number | null
  submittedText: string
  periodText: string
  versionText: string
  sections: Array<{ id: keyof Ready["sections"]; title: string; blurb: string; items: MetricView[] }>
  readiness: Array<{ id: string; label: string; value: string }>
  goal: { primary: string | null; secondary: string | null; note: string | null }
  /** True when every figure is an owner estimate or unknown (no connected or observed evidence yet). */
  ownerEstimatesOnly: boolean
}

const choiceText = (map: Record<string, string>, v: string | "unknown" | null): string =>
  v === null ? "Not answered" : v === "unknown" ? "I’m not sure" : map[v] ?? v

export function buildReportView(dto: Ready): ReportView {
  const sections = (Object.keys(SECTION_REPORT_COPY) as Array<keyof Ready["sections"]>).map((id) => ({
    id,
    title: SECTION_REPORT_COPY[id].title,
    blurb: SECTION_REPORT_COPY[id].blurb,
    items: dto.sections[id].map(describeMetric),
  }))
  const channels = dto.readiness.activeChannels
  const all = sections.flatMap((s) => s.items)
  return {
    revision: dto.revision,
    replacesRevision: dto.supersedesRevision,
    submittedText: formatDate(dto.submittedAt),
    periodText: formatDateRange(dto.reportingPeriod.start, dto.reportingPeriod.end),
    versionText: dto.catalogVersion,
    sections,
    readiness: [
      { id: "records_system", label: "Customer records", value: choiceText(READINESS_LABELS.records_system, dto.readiness.recordsSystem) },
      { id: "calendar_system", label: "Calendar", value: choiceText(READINESS_LABELS.calendar_system, dto.readiness.calendarSystem) },
      {
        id: "active_channels",
        label: "How customers reach you",
        value: channels === null ? "Not answered" : channels === "unknown" ? "I’m not sure" : channels.map((c) => READINESS_LABELS.active_channels[c] ?? c).join(", "),
      },
    ],
    goal: {
      primary: dto.goal.primary ? OUTCOME_LABELS[dto.goal.primary] ?? dto.goal.primary : null,
      secondary: dto.goal.secondary ? OUTCOME_LABELS[dto.goal.secondary] ?? dto.goal.secondary : null,
      note: dto.goal.note,
    },
    ownerEstimatesOnly: all.every((m) => m.evidence === null || m.evidence.kind === "owner" || m.evidence.kind === "unsure"),
  }
}
