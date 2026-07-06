import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, PhoneCall, Sparkles, User } from "lucide-react"

import { StatusPill } from "@/components/ui/status-pill"
import { getCallRecordView } from "@/lib/data/call-records"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"

export const dynamic = "force-dynamic"

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function fmtDuration(seconds: number | null): string | null {
  if (!seconds || seconds <= 0) return null
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/** "customer-ended-call" → "customer ended call" — formatting only. */
function fmtEndedReason(reason: string | null): string | null {
  if (!reason?.trim()) return null
  return reason.trim().replace(/[-_]+/g, " ")
}

/**
 * The call record (spec §5.2 canon): summary on top → structured
 * outcomes → actions from this call (with decision-log lines where they
 * exist) → full transcript → recording. Every section renders only if
 * its data was actually captured (call_records starts at the L0.5
 * deploy); a legacy call still shows its transcript. The transcript is
 * the CHARACTER speaking — verbatim turns, never paraphrased.
 */
export default async function CallRecordPage({
  params,
}: {
  params: Promise<{ callId: string }>
}) {
  await requireShop()
  const { callId } = await params
  const view = await getCallRecordView(decodeURIComponent(callId))
  if (!view) notFound()

  const s = STRINGS.pages.call
  const { record } = view
  const when = fmtWhen(record?.started_at ?? null)
  const duration = fmtDuration(record?.duration_seconds ?? null)
  const endedReason = fmtEndedReason(record?.ended_reason ?? null)

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <Link
          href="/activity"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {s.backToActivity}
        </Link>
      </div>

      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">{s.eyebrow}</p>
        <h1 className="font-display text-2xl text-foreground">
          {view.customerName ?? s.titleFallback}
        </h1>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <PhoneCall className="size-3.5" aria-hidden />
            {when ?? "Voice call"}
          </span>
          {duration ? <span className="font-data">{duration}</span> : null}
          {endedReason ? <span>ended: {endedReason}</span> : null}
        </p>
      </header>

      {/* Summary — only what the end-of-call report actually carried. */}
      <section className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">
          {s.summaryHeading}
        </p>
        {record?.summary?.trim() ? (
          <p className="rounded-md border border-border/60 bg-card px-4 py-3.5 text-sm leading-relaxed text-foreground/90">
            {record.summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{s.noSummary}</p>
        )}
      </section>

      {/* Actions this call staged, with the decision log's WHY. */}
      {view.actions.length > 0 ? (
        <section className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">
            {s.actionsHeading}
          </p>
          <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card">
            {view.actions.map((a) => (
              <li key={a.id} className="space-y-1 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">
                    {a.summary}
                  </p>
                  <StatusPill
                    tone={
                      a.status === "pending" || a.status === "edit_requested"
                        ? "warn"
                        : a.status === "rejected"
                          ? "muted"
                          : "good"
                    }
                  >
                    {a.status === "pending" || a.status === "edit_requested"
                      ? "Needs you"
                      : a.status === "rejected"
                        ? "Dropped"
                        : "Done"}
                  </StatusPill>
                </div>
                {a.because ? (
                  <p className="border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
                    <span className="font-medium text-muted-foreground/80">
                      {STRINGS.pages.activity.whyLabel}:
                    </span>{" "}
                    {a.because}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Transcript — the character speaking, verbatim. */}
      {view.turns.length > 0 ? (
        <section className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">
            {s.transcriptHeading}
          </p>
          <div className="space-y-3 rounded-md border border-border/60 bg-card px-4 py-4">
            {view.turns.map((t) => (
              <div key={t.id} className="flex items-start gap-3">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                  {t.role === "gradia" ? (
                    <Sparkles className="size-3.5" aria-hidden />
                  ) : (
                    <User className="size-3.5" aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t.role === "gradia" ? s.receptionist : s.caller}
                  </p>
                  <p className="text-sm leading-relaxed text-foreground/90">
                    {t.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Recording — only when a URL was captured. */}
      {record?.recording_url ? (
        <section className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">
            {s.recordingHeading}
          </p>
          <audio
            controls
            preload="none"
            src={record.recording_url}
            className="w-full"
          />
        </section>
      ) : null}
    </div>
  )
}
