import type { MetricKey } from "./catalog"

export type EvidenceClass =
  | "owner_estimate"
  | "connected_evidence"
  | "gradia_observed"
  | "derived"
  | "unknown"

/** measured = a value exists; unknown = explicitly not known; not_measured = nothing to show. */
export type MetricStatus = "measured" | "unknown" | "not_measured"
export type MetricReason =
  | "input_unknown"
  | "input_missing"
  | "input_is_range"
  | "zero_denominator"
  | "inconsistent_inputs"

export type MetricInput =
  | { kind: "answer"; revision: number; questionKey: string }
  | { kind: "measurement"; measurementId: string }

export type MetricPeriod =
  | { kind: "normal_period"; start: string; end: string } // owner estimate: the reporting period (dates)
  | { kind: "window"; start: string; end: string } // observed: exact timestamps

export type MetricItem = {
  key: MetricKey
  status: MetricStatus
  value: number | null
  range: { min: number; max: number } | null
  unit: string | null
  evidenceClass: EvidenceClass | null
  /** Weakest evidence among a derived metric's inputs; what the owner-facing label follows. */
  basisEvidenceClass: EvidenceClass | null
  period: MetricPeriod | null
  definitionVersion: string
  formulaVersion: string | null
  inputs: MetricInput[]
  sourceSystem: string | null
  sourceRef: string | null
  reason: MetricReason | null
}

export type DraftSummary = {
  draftVersion: number
  catalogVersion: string
  updatedByRole: "owner" | "manager"
  updatedAt: string
  answers: Record<string, unknown>
}

export type StartingPointDto =
  | {
      status: "ready"
      role: "owner" | "manager"
      catalogVersion: string
      revision: number
      supersedesRevision: number | null
      submittedAt: string
      reportingPeriod: { start: string; end: string }
      sections: {
        response: MetricItem[]
        booking: MetricItem[]
        followUp: MetricItem[]
        operatingLoad: MetricItem[]
      }
      readiness: {
        recordsSystem: string | "unknown" | null
        calendarSystem: string | "unknown" | null
        activeChannels: string[] | "unknown" | null
      }
      goal: { primary: string | null; secondary: string | null; note: string | null }
      draft: DraftSummary | null
    }
  | { status: "not_started"; role: "owner" | "manager"; draft: DraftSummary | null }
  | { status: "forbidden" }
  | { status: "unavailable" }

export type NotComparableReason =
  | "baseline_not_measured"
  | "current_not_measured"
  | "baseline_unknown"
  | "current_unknown"
  | "baseline_is_range"
  | "definition_changed"
  | "unit_changed"
  | "window_length_differs"
  | "window_too_short"
  | "windows_overlap"
  | "ambiguous_current_evidence"

export type ComparisonItem =
  | { key: MetricKey; status: "comparable"; baseline: MetricItem; current: MetricItem; delta: number }
  /** Baseline is only an owner estimate: both numbers shown, no delta, no improvement claim. */
  | { key: MetricKey; status: "reference_only"; baseline: MetricItem; current: MetricItem }
  | {
      key: MetricKey
      status: "not_comparable"
      reason: NotComparableReason
      baseline: MetricItem | null
      current: MetricItem | null
    }

export type ComparisonDto =
  | {
      status: "ready"
      baselineRevision: number
      window: { start: string; end: string }
      items: ComparisonItem[]
    }
  | { status: "not_started" }
  | { status: "forbidden" }
  | { status: "unavailable" }

/** Raw rows as returned by the baseline_read / baseline_read_window RPCs. */
export type MeasurementRow = {
  id: string
  metric_key: string
  definition_version: string
  evidence_class: Exclude<EvidenceClass, "owner_estimate">
  value: number | null
  unit: string
  window_start: string
  window_end: string
  source_system: string | null
  source_ref: string | null
  formula_version: string | null
  inputs: Array<{ measurement_id: string }>
}
export type BaselineReadResult = {
  role: "owner" | "manager"
  pointer: { revision: number; advanced_at: string } | null
  revision: {
    revision: number
    catalog_version: string
    answers: Record<string, unknown>
    reporting_period_start: string
    reporting_period_end: string
    supersedes_revision: number | null
    submitted_at: string
  } | null
  measurements: MeasurementRow[]
  draft: {
    draft_version: number
    catalog_version: string
    answers: Record<string, unknown>
    updated_by_role: "owner" | "manager"
    updated_at: string
  } | null
}
