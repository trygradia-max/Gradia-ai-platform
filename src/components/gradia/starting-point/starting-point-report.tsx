import { Calculator, CircleDashed, CircleHelp, Eye, PenLine, PlugZap } from "lucide-react"
import type { ReactNode } from "react"

import { StatusPill } from "@/components/ui/status-pill"
import type { StartingPointDto } from "@/lib/onboarding-baseline/dto"
import { EVIDENCE_LABELS } from "@/lib/onboarding-baseline/copy"
import { buildReportView, type EvidenceKind, type MetricView } from "@/lib/onboarding-baseline/report-model"
import { STRINGS } from "@/lib/strings"

const T = STRINGS.pages.startingPoint

/** Status is always icon + text, never colour alone. Evidence labels are neutral: they describe a source, not good or bad. */
const ICON: Record<EvidenceKind, typeof PenLine> = {
  owner: PenLine,
  connected: PlugZap,
  observed: Eye,
  unsure: CircleHelp,
  calculated: Calculator,
  none: CircleDashed,
}

function EvidencePill({ kind, label }: { kind: EvidenceKind; label: string }) {
  const Icon = ICON[kind]
  return (
    <StatusPill tone="muted" size="default" icon={<Icon className="size-3" aria-hidden />}>
      {label}
    </StatusPill>
  )
}

function Metric({ m }: { m: MetricView }) {
  const hasFigure = m.valueText !== null
  return (
    <li className="rounded-md bg-card p-4 ring-1 ring-border sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <h4 className="text-sm font-medium text-foreground">{m.title}</h4>
          <p className="text-xs text-muted-foreground">{m.help}</p>
        </div>
        {hasFigure && m.evidence ? <EvidencePill kind={m.evidence.kind} label={m.evidence.label} /> : null}
      </div>

      {hasFigure ? (
        <p className="mt-3 font-data text-2xl font-semibold text-foreground">{m.valueText}</p>
      ) : (
        // No figure: say so in words with an icon. A missing or unknown answer is never a blank or a zero.
        <p className="mt-3 flex items-center gap-2 text-base font-medium text-muted-foreground">
          {m.state === "unknown" ? <CircleHelp className="size-4" aria-hidden /> : <CircleDashed className="size-4" aria-hidden />}
          {m.stateLabel}
        </p>
      )}

      <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
        {m.evidence && hasFigure ? (
          <div>
            <dt className="sr-only">Evidence</dt>
            <dd>{m.evidence.detail}</dd>
          </div>
        ) : null}
        {m.methodText ? (
          <div>
            <dt className="sr-only">Method</dt>
            <dd>{m.methodText}</dd>
          </div>
        ) : null}
        {m.periodText ? (
          <div>
            <dt className="sr-only">Period</dt>
            <dd>{m.periodText}</dd>
          </div>
        ) : null}
        {m.reasonText ? (
          <div>
            <dt className="sr-only">Why there is no figure</dt>
            <dd>{m.reasonText}</dd>
          </div>
        ) : null}
      </dl>

      {m.details.length > 0 && m.evidence ? (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="min-h-6 cursor-pointer rounded-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            {T.howWorkedOut}
          </summary>
          <p className="mt-1.5">{m.details.join(" · ")}</p>
        </details>
      ) : null}
    </li>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  )
}

/**
 * The Starting point report. It renders the server DTO and nothing else: no figure is computed here,
 * no delta is shown, and a failed or forbidden read never reaches this component (callers render a
 * written state). Mobile first: single column, wraps at any width, readable at 200% zoom.
 */
export function StartingPointReport({
  dto,
  actions,
}: {
  dto: Extract<StartingPointDto, { status: "ready" }>
  /** Update / continue-draft actions, supplied by the caller (the report itself has no client logic). */
  actions?: ReactNode
}) {
  const view = buildReportView(dto)
  return (
    <article aria-labelledby="starting-point-report-title" className="space-y-8">
      <header className="space-y-3">
        <div className="space-y-1">
          <p className="label-eyebrow text-muted-foreground">{T.reportEyebrow}</p>
          <h2 id="starting-point-report-title" className="text-xl font-semibold tracking-tight text-foreground">
            {T.reportTitle}
          </h2>
        </div>
        <p className="font-data text-sm text-muted-foreground">
          {T.reportFacts(view.revision, view.submittedText, view.versionText)}
        </p>
        <p className="text-sm text-foreground">{T.reportPeriod(view.periodText)}</p>
        {view.replacesRevision ? <p className="text-sm text-muted-foreground">{T.replaces(view.replacesRevision)}</p> : null}
        <p className="max-w-prose text-sm text-muted-foreground">
          {view.ownerEstimatesOnly ? T.ownerOnlyNote : T.measuredNote}
        </p>
        {actions ? <div className="flex flex-wrap items-center gap-3 pt-1">{actions}</div> : null}
      </header>

      <section aria-labelledby="sp-legend" className="rounded-md bg-muted/40 p-4 ring-1 ring-border">
        <h4 id="sp-legend" className="text-sm font-medium text-foreground">
          {T.legendTitle}
        </h4>
        <ul className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          {(["owner_estimate", "connected_evidence", "gradia_observed", "unknown"] as const).map((k) => (
            <li key={k} className="flex items-start gap-2">
              <EvidencePill
                kind={k === "owner_estimate" ? "owner" : k === "connected_evidence" ? "connected" : k === "gradia_observed" ? "observed" : "unsure"}
                label={EVIDENCE_LABELS[k].label}
              />
              <span className="pt-0.5">{EVIDENCE_LABELS[k].detail}</span>
            </li>
          ))}
          <li className="flex items-start gap-2 sm:col-span-2">
            <EvidencePill kind="none" label="Not measured yet" />
            <span className="pt-0.5">Nothing has been recorded for this. It is shown as missing, never as zero.</span>
          </li>
        </ul>
      </section>

      {view.sections.map((section) => (
        <section key={section.id} aria-labelledby={`sp-${section.id}`} className="space-y-3">
          <div>
            <h3 id={`sp-${section.id}`} className="text-base font-semibold text-foreground">
              {section.title}
            </h3>
            <p className="text-sm text-muted-foreground">{section.blurb}</p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {section.items.map((m) => (
              <Metric key={m.key} m={m} />
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="sp-systems" className="space-y-3">
        <h3 id="sp-systems" className="text-base font-semibold text-foreground">
          {T.systemsTitle}
        </h3>
        <dl className="space-y-3 rounded-md bg-card p-4 ring-1 ring-border sm:p-5">
          {view.readiness.map((r) => (
            <Row key={r.id} label={r.label}>
              {r.value}
            </Row>
          ))}
          {view.goal.primary ? <Row label={T.goalPrimary}>{view.goal.primary}</Row> : null}
          {view.goal.secondary ? <Row label={T.goalSecondary}>{view.goal.secondary}</Row> : null}
          {view.goal.note ? <Row label={T.goalNote}>{view.goal.note}</Row> : null}
        </dl>
      </section>

      <p className="max-w-prose text-sm text-muted-foreground">{T.noComparison}</p>
    </article>
  )
}
