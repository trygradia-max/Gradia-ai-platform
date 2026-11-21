import { AlertTriangle, CheckCircle2, CircleHelp } from "lucide-react"

import { StatusPill } from "@/components/ui/status-pill"
import type { ReviewDetail } from "@/lib/call-copilot/review-dto"
import { coverageReasonCopy, freshnessCopy, gapReasonCopy } from "@/lib/call-copilot/review-model"
import { STRINGS } from "@/lib/strings"

import { fmtClock, fmtUtc } from "./format"

const RUN_COPY = {
  completed: { label: "Finished", tone: "good" as const },
  unknown_outcome: { label: "Outcome unknown", tone: "bad" as const },
  failed_before_effect: { label: "Failed before anything was sent", tone: "warn" as const },
}

/** Evidence coverage and gaps, the extraction runs, and whether the evidence is still the evidence that was prepared. */
export function EvidencePanel({ detail }: { detail: ReviewDetail }) {
  const s = STRINGS.pages.callReview
  const sel = detail.evidence.selected
  return (
    <section aria-labelledby="evidence-heading" className="space-y-4 rounded-md bg-card p-5 ring-1 ring-border">
      <h2 id="evidence-heading" className="label-eyebrow text-muted-foreground">{s.evidenceHeading}</h2>

      {!sel ? (
        <p className="text-sm text-muted-foreground">No transcript evidence has been prepared for this call yet, so there is nothing to propose.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              tone={sel.coverage_status === "complete" ? "good" : "warn"}
              icon={sel.coverage_status === "complete" ? <CheckCircle2 className="size-3.5" aria-hidden /> : <AlertTriangle className="size-3.5" aria-hidden />}
            >
              {sel.coverage_status === "complete" ? "Complete transcript" : "Partial transcript"}
            </StatusPill>
            <StatusPill tone={sel.current ? "good" : "bad"} icon={sel.current ? <CheckCircle2 className="size-3.5" aria-hidden /> : <AlertTriangle className="size-3.5" aria-hidden />}>
              {sel.current ? "Current" : "Out of date"}
            </StatusPill>
            <span className="text-sm text-muted-foreground">Evidence version {sel.revision}{sel.is_latest ? "" : " (older)"}</span>
          </div>
          {!sel.current ? (
            <p role="alert" className="rounded-sm bg-status-warning-bg px-3 py-2 text-sm text-status-warning-fg">
              {freshnessCopy(sel.not_current_reason === "evidence_superseded" ? "evidence_superseded" : "call_evidence_changed")}
            </p>
          ) : null}
          <p className="font-data text-sm text-muted-foreground">
            {sel.segment_count} transcript segment{sel.segment_count === 1 ? "" : "s"}
            {sel.expected_segment_count !== null ? ` of ${sel.expected_segment_count} expected` : " (expected number unknown)"}
          </p>
          {sel.coverage_reasons.length > 0 ? (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">Why it is partial</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                {sel.coverage_reasons.map((r) => <li key={r}>{coverageReasonCopy(r)}</li>)}
              </ul>
            </div>
          ) : null}
          {sel.gaps.length > 0 ? (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">Gaps in the call</h3>
              <ul className="space-y-1 text-sm">
                {sel.gaps.map((g, n) => (
                  <li key={n}>
                    <span className="font-data">{fmtClock(g.started_at)} to {g.ended_at ? fmtClock(g.ended_at) : "now"}</span>
                    <span className="text-muted-foreground"> · {gapReasonCopy(g.reason)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <div className="space-y-2 border-t border-border pt-3">
        <h3 className="text-xs font-medium text-muted-foreground">{s.extractionHeading}</h3>
        {detail.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Gradia has not prepared proposals from this call yet.</p>
        ) : (
          <ul className="space-y-2">
            {detail.runs.map((r, n) => {
              const copy = RUN_COPY[r.status]
              return (
                <li key={n} className="space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill size="sm" tone={copy.tone} icon={r.status === "completed" ? undefined : <CircleHelp className="size-3" aria-hidden />}>{copy.label}</StatusPill>
                    <span className="text-muted-foreground">Evidence version {r.revision} · {fmtUtc(r.created_at)}{r.requested_by_me ? " · asked by you" : ""}</span>
                  </div>
                  {r.status === "unknown_outcome" ? (
                    <p className="text-muted-foreground">Gradia could not confirm what happened, so it did not try again on its own. A person needs to decide what to do next.</p>
                  ) : null}
                  {r.status === "failed_before_effect" ? (
                    <p className="text-muted-foreground">It failed before anything was sent or saved. No proposals were made from this run.</p>
                  ) : null}
                  {r.status === "completed" ? (
                    <p className="text-muted-foreground">
                      {r.proposal_count} proposal{r.proposal_count === 1 ? "" : "s"}
                      {r.refused_count > 0 ? ` · ${r.refused_count} dropped on purpose (it looked like an instruction or sensitive data)` : ""}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
