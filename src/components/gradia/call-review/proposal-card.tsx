import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, Eye, Lock, Quote } from "lucide-react"

import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import type { ReviewProposal } from "@/lib/call-copilot/review-dto"
import {
  CONFIDENCE_COPY, KIND_GROUP, KIND_LABEL, SNIPPET_COPY, describeChange, displayValue, fieldLabel, freshnessCopy,
  proposalState, reviewReasonCopy, speakerCopy,
} from "@/lib/call-copilot/review-model"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

import { fmtClock } from "./format"

export type CardResult = { tone: "good" | "bad" | "warn"; message: string } | null

/** Plain-language ambiguity. Candidate ids never reach here, only counts and the values the caller and the record disagree on. */
function Ambiguity({ p }: { p: ReviewProposal }) {
  const a = p.ambiguity
  if (!a) return null
  const items: string[] = []
  if (a.candidate_customers !== undefined) items.push(a.candidate_customers === 0 ? "No customer on file matches." : `${a.candidate_customers} customer${a.candidate_customers === 1 ? "" : "s"} on file could match.`)
  if (a.candidate_vehicles !== undefined) items.push(`${a.candidate_vehicles} vehicle${a.candidate_vehicles === 1 ? "" : "s"} on file could match.`)
  if (a.existing_vehicles !== undefined) items.push(`${a.existing_vehicles} vehicle${a.existing_vehicles === 1 ? " is" : "s are"} already on file for this customer.`)
  for (const c of a.conflicts ?? []) items.push(`${fieldLabel(c.field)}: on file "${c.crm}", heard "${c.heard}".`)
  if (a.ungrounded_fields?.length) items.push(`Not clearly stated in the cited words: ${a.ungrounded_fields.map(fieldLabel).join(", ")}.`)
  if (a.invalid_fields?.length) items.push(`Could not be read as a valid value: ${a.invalid_fields.map(fieldLabel).join(", ")}.`)
  if (a.invalid_payload) items.push("The details did not fit the required format.")
  if (a.note) items.push(a.note)
  if (items.length === 0) return null
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">What is unclear</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">{items.map((t) => <li key={t}>{t}</li>)}</ul>
    </div>
  )
}

function Citations({ p, withheld }: { p: ReviewProposal; withheld: boolean }) {
  return (
    <div className="space-y-3">
      <h4 className="label-eyebrow flex items-center gap-1.5 text-muted-foreground">
        <Quote className="size-3" aria-hidden />
        {STRINGS.pages.callReview.heardHeading}
      </h4>
      <ul className="space-y-3">
        {p.fields.map((f) => (
          <li key={f.name} className="space-y-1.5">
            <p className="text-sm text-foreground">
              <span className="font-medium">{fieldLabel(f.name)}:</span> {displayValue(f.value)}
              <span className="ml-2 text-xs text-muted-foreground">{CONFIDENCE_COPY[f.confidence]}</span>
            </p>
            <ul className="space-y-1.5">
              {f.citations.map((c, i) => (
                <li key={i} className="rounded-sm border-l-2 border-border bg-muted/40 py-1.5 pl-3 pr-2 text-sm">
                  <span className="block text-xs text-muted-foreground">
                    {speakerCopy(c.speaker)} · <span className="font-data">{fmtClock(c.at)}</span>
                  </span>
                  {c.state === "shown" && c.snippet ? (
                    <q className="block text-foreground">{c.snippet}</q>
                  ) : (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Lock className="size-3 shrink-0" aria-hidden />
                      {withheld ? SNIPPET_COPY.withheld : SNIPPET_COPY[c.state === "shown" ? "unavailable" : c.state]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One source-cited proposal. Presentational: the parent owns selection and the decide handlers. A button appears only
 * when the viewer is the owner AND the proposal is ready; every other state says in words why there is none.
 */
export function ProposalCard({
  proposal: p, all, viewerCanApprove, snippetsWithheld, selected, busy, anyBusy, result, onToggle, onApprove, onDismiss,
}: {
  proposal: ReviewProposal
  all: readonly ReviewProposal[]
  viewerCanApprove: boolean
  snippetsWithheld: boolean
  selected: boolean
  busy: boolean
  anyBusy: boolean
  result: CardResult
  onToggle?: (p: ReviewProposal) => void
  onApprove?: (p: ReviewProposal) => void
  onDismiss?: (p: ReviewProposal) => void
}) {
  const s = STRINGS.pages.callReview
  const state = proposalState(p, all)
  const change = describeChange(p)
  const titleId = `proposal-${p.id}`
  const ready = state.kind === "ready" && viewerCanApprove
  // Anything still waiting on the owner can be dismissed, including a proposal that went stale or is waiting for an earlier step,
  // so a dead proposal can never block its dependents for good. Only a ready one can be approved or selected.
  const dismissible = viewerCanApprove && (state.kind === "ready" || state.kind === "stale" || state.kind === "blocked_by" || state.kind === "edit_requested")
  const reviewReason = reviewReasonCopy(p.review_reason)

  const status = (() => {
    switch (state.kind) {
      case "ready": return <StatusPill tone="warn" icon={<Clock3 className="size-3.5" aria-hidden />}>Waiting on you</StatusPill>
      case "review_only": return <StatusPill tone="muted" icon={<Eye className="size-3.5" aria-hidden />}>{s.reviewOnlyBadge}</StatusPill>
      case "blocked_by": return <StatusPill tone="muted" icon={<Clock3 className="size-3.5" aria-hidden />}>Waiting for an earlier step</StatusPill>
      case "stale": return <StatusPill tone="bad" icon={<AlertTriangle className="size-3.5" aria-hidden />}>Can&apos;t be approved</StatusPill>
      case "approved": return <StatusPill tone="good" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>{state.executed ? "Approved and done" : "Approved"}</StatusPill>
      case "dismissed": return <StatusPill tone="muted" icon={<CircleSlash className="size-3.5" aria-hidden />}>Dismissed</StatusPill>
      case "edit_requested": return <StatusPill tone="warn">Needs a change</StatusPill>
    }
  })()

  return (
    <article aria-labelledby={titleId} className={cn("space-y-4 rounded-md bg-card p-5 ring-1 ring-border sm:p-6", selected && "ring-2 ring-primary")}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="label-eyebrow text-muted-foreground">{KIND_GROUP[p.kind]} · {KIND_LABEL[p.kind]}</p>
          <h3 id={titleId} className="font-display text-lg text-foreground">{change.headline}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status}
          <StatusPill size="sm" tone={p.confidence === "high" ? "good" : p.confidence === "medium" ? "warn" : "bad"}>{CONFIDENCE_COPY[p.confidence]}</StatusPill>
        </div>
      </header>

      {change.lines.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          {change.lines.map((l, i) => (
            <div key={`${l.label}-${i}`} className="contents">
              <dt className="text-muted-foreground">{l.label}</dt>
              <dd className="min-w-0 break-words text-foreground">{l.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {change.binding ? <p className="text-sm text-muted-foreground">{change.binding}</p> : null}

      {state.kind === "review_only" ? (
        <div role="note" className="space-y-1 rounded-sm bg-muted px-3 py-2 text-sm">
          {reviewReason ? <p className="text-foreground">{reviewReason}</p> : null}
          <p className="text-muted-foreground">{p.kind === "memory_candidate" ? s.memoryNote : s.reviewOnlyNote}</p>
        </div>
      ) : null}
      {state.kind === "stale" ? (
        <p role="alert" className="rounded-sm bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg">{freshnessCopy(state.reason)}</p>
      ) : null}
      {state.kind === "blocked_by" ? (
        <p role="note" className="rounded-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
          {s.blockedBy(state.prerequisites.map((k) => KIND_LABEL[k].toLowerCase()).join(" and "))}
        </p>
      ) : null}
      {p.route === "pending_action" && p.freshness === null && p.status === "pending" && !p.requested_by_me ? (
        <p className="text-xs text-muted-foreground">Prepared by another team member. It stays tied to their access.</p>
      ) : null}

      <Ambiguity p={p} />
      <Citations p={p} withheld={snippetsWithheld} />

      {result ? (
        <p role={result.tone === "good" ? "status" : "alert"} className={cn("rounded-sm px-3 py-2 text-sm",
          result.tone === "good" ? "bg-status-success-bg text-status-success-fg" : result.tone === "warn" ? "bg-status-warning-bg text-status-warning-fg" : "bg-status-danger-bg text-status-danger-fg")}>
          {result.message}
        </p>
      ) : null}

      {dismissible ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          {ready ? (
            <>
              <label className="inline-flex min-h-11 items-center gap-2 text-sm text-foreground">
                <input type="checkbox" className="size-4 accent-primary" checked={selected} disabled={anyBusy} onChange={() => onToggle?.(p)} />
                <span>{s.select}<span className="sr-only"> {change.headline}</span></span>
              </label>
              <Button type="button" className="min-h-11" disabled={anyBusy} aria-busy={busy} onClick={() => onApprove?.(p)}>
                {busy ? s.approving : s.approve}
              </Button>
            </>
          ) : null}
          <Button type="button" variant="outline" className="min-h-11" disabled={anyBusy} onClick={() => onDismiss?.(p)}>{s.dismiss}</Button>
        </div>
      ) : null}
    </article>
  )
}
