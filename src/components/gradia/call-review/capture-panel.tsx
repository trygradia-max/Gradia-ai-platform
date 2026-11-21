import { PauseCircle, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react"

import { StatusPill } from "@/components/ui/status-pill"
import type { ReviewCapture } from "@/lib/call-copilot/review-dto"
import { CAPTURE_STATUS_COPY, captureReasonCopy, gapReasonCopy } from "@/lib/call-copilot/review-model"
import { STRINGS } from "@/lib/strings"

import { fmtClock } from "./format"

const ICON = { good: ShieldCheck, warn: PauseCircle, bad: ShieldAlert, muted: ShieldQuestion } as const

/** Capture and consent state, as plain facts. Never implies a recording exists unless consent was established. */
export function CapturePanel({ capture }: { capture: ReviewCapture }) {
  const s = STRINGS.pages.callReview
  const copy = CAPTURE_STATUS_COPY[capture.status]
  const Icon = ICON[copy.tone]
  return (
    <section aria-labelledby="capture-heading" className="space-y-3 rounded-md bg-card p-5 ring-1 ring-border">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="capture-heading" className="label-eyebrow text-muted-foreground">{s.captureHeading}</h2>
        <StatusPill tone={copy.tone} icon={<Icon className="size-3.5" aria-hidden />}>{copy.label}</StatusPill>
      </div>
      <p className="text-sm text-foreground">{copy.detail}</p>
      <p className="text-sm text-muted-foreground">{captureReasonCopy(capture.reason)}</p>

      {capture.conflict_count > 0 || capture.transcript_conflicts > 0 ? (
        <p role="note" className="rounded-sm bg-status-danger-bg px-3 py-2 text-sm text-status-danger-fg">
          The phone provider sent records that disagree with each other. Gradia treats this call as unusable until a person looks at it.
        </p>
      ) : null}

      {capture.intervals.length > 0 || capture.gaps.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">Captured</h3>
            {capture.intervals.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing was captured.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {capture.intervals.map((i, n) => (
                  <li key={n} className="font-data">
                    {fmtClock(i.started_at)} to {i.ended_at ? fmtClock(i.ended_at) : "now"}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">Not captured</h3>
            {capture.gaps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No gaps.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {capture.gaps.map((g, n) => (
                  <li key={n}>
                    <span className="font-data">{fmtClock(g.started_at)} to {g.ended_at ? fmtClock(g.ended_at) : "now"}</span>
                    <span className="block text-muted-foreground">{gapReasonCopy(g.reason)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
