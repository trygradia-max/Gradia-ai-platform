import Link from "next/link"
import {
  CircleAlert,
  ClipboardCheck,
  Clock3,
  TriangleAlert,
} from "lucide-react"

import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { ReviewCard } from "@/components/gradia/review-card"
import { SectionHeader } from "@/components/gradia/section-header"
import { StatusPill } from "@/components/ui/status-pill"
import type { OperationsQueueItem, OperationsSource } from "@/lib/operations-queue"
import type { OperationsOverview } from "@/lib/operations-queue-reader"
import { STRINGS } from "@/lib/strings"

const observedAtFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
})

function formatObservedAt(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.valueOf())
    ? observedAtFormatter.format(date)
    : STRINGS.pages.operationsBrief.observedUnknown
}

function sourceLabel(source: OperationsSource, state: OperationsQueueItem["state"]): string {
  if (source.kind === "intake_workflow") {
    return STRINGS.pages.operationsBrief.sources.intake
  }
  if (state === "outcome_unconfirmed") {
    return STRINGS.pages.operationsBrief.sources.deliveryEvidence
  }
  return STRINGS.pages.operationsBrief.sources.actions[source.actionType]
}

function OperationsItem({ item }: { item: OperationsQueueItem }) {
  const unconfirmed = item.state === "outcome_unconfirmed"
  const title = unconfirmed
    ? STRINGS.pages.operationsBrief.unconfirmedTitle
    : STRINGS.pages.operationsBrief.needsReviewTitle

  return (
    <li>
      <ReviewCard
        eyebrow={STRINGS.pages.operationsBrief.itemEyebrow}
        title={title}
        status={
          <StatusPill
            tone="warn"
            size="default"
            icon={
              unconfirmed ? (
                <CircleAlert className="size-3.5" aria-hidden />
              ) : (
                <ClipboardCheck className="size-3.5" aria-hidden />
              )
            }
          >
            {unconfirmed
              ? STRINGS.pages.operationsBrief.unconfirmedStatus
              : STRINGS.pages.operationsBrief.needsReviewStatus}
          </StatusPill>
        }
        evidence={
          <p className="flex items-center gap-2">
            <Clock3 className="size-4 shrink-0" aria-hidden />
            <span>{STRINGS.pages.operationsBrief.itemObserved}</span>
            <time dateTime={item.observedAt}>{formatObservedAt(item.observedAt)}</time>
          </p>
        }
        actions={item.sources.map((source) => (
          <Link
            key={`${source.kind}:${source.id}`}
            href={source.href}
            className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sourceLabel(source, item.state)}
          </Link>
        ))}
      />
    </li>
  )
}

/**
 * Read-only presentation of one authorized OperationsOverview page. Source links
 * and counts come from the server projection; this component neither selects a
 * workspace nor mutates, retries or resolves any underlying work.
 */
export function OperationsOverviewBrief({ overview }: { overview: OperationsOverview }) {
  const { queue, brief } = overview
  const ready =
    queue.status === "ready" && brief.status === "ready" ? { queue, brief } : null
  const observedAt = formatObservedAt(queue.observedAt)

  return (
    <section className="space-y-5" aria-labelledby="operations-brief-heading">
      <SectionHeader
        eyebrow={STRINGS.pages.operationsBrief.eyebrow}
        title={<span id="operations-brief-heading">{STRINGS.pages.operationsBrief.title}</span>}
        subhead={
          <>
            {STRINGS.pages.operationsBrief.subhead}{" "}
            <span>
              {STRINGS.pages.operationsBrief.observedLabel}{" "}
              <time dateTime={queue.observedAt}>{observedAt}</time>.
            </span>
          </>
        }
      />

      {!ready ? (
        <ErrorState
          compact
          title={STRINGS.pages.operationsBrief.unavailableTitle}
          description={STRINGS.pages.operationsBrief.unavailableBody}
        />
      ) : ready.queue.items.length === 0 ? (
        <EmptyState
          title={STRINGS.pages.operationsBrief.emptyTitle}
          description={STRINGS.pages.operationsBrief.emptyBody}
          className="py-8"
        />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md bg-card p-4 ring-1 ring-border">
              <p className="text-sm text-muted-foreground">
                {STRINGS.pages.operationsBrief.needsReviewCount}
              </p>
              <p className="font-data mt-1 text-2xl font-semibold tabular-nums">
                {ready.brief.countsInLoadedWindow.needsReview}
              </p>
            </div>
            <div className="rounded-md bg-card p-4 ring-1 ring-border">
              <p className="text-sm text-muted-foreground">
                {STRINGS.pages.operationsBrief.unconfirmedCount}
              </p>
              <p className="font-data mt-1 text-2xl font-semibold tabular-nums">
                {ready.brief.countsInLoadedWindow.outcomeUnconfirmed}
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {STRINGS.pages.operationsBrief.loadedWindowNote}
          </p>

          {ready.brief.coverage === "partial" ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-status-warning-bg px-4 py-3 text-sm text-status-warning-fg">
              <StatusPill
                tone="warn"
                size="default"
                icon={<TriangleAlert className="size-3.5" aria-hidden />}
              >
                {STRINGS.pages.operationsBrief.partialStatus}
              </StatusPill>
              <span>{STRINGS.pages.operationsBrief.partialBody}</span>
            </div>
          ) : null}

          {ready.brief.sections.map((section) =>
            section.items.length > 0 ? (
              <section
                key={section.kind}
                className="space-y-3"
                aria-labelledby={`operations-${section.kind}`}
              >
                <h3 id={`operations-${section.kind}`} className="font-display text-lg">
                  {section.kind === "needs_review"
                    ? STRINGS.pages.operationsBrief.needsReviewSection
                    : STRINGS.pages.operationsBrief.unconfirmedSection}
                </h3>
                <ol className="space-y-3">
                  {section.items.map((item) => (
                    <OperationsItem key={item.workKey} item={item} />
                  ))}
                </ol>
              </section>
            ) : null
          )}
        </div>
      )}
    </section>
  )
}
