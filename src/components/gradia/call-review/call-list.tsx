import Link from "next/link"
import { ChevronRight } from "lucide-react"

import { EmptyState } from "@/components/gradia/empty-state"
import { Pagination } from "@/components/gradia/pagination"
import { StatusPill } from "@/components/ui/status-pill"
import type { ReviewList } from "@/lib/call-copilot/review-dto"
import { CAPTURE_STATUS_COPY } from "@/lib/call-copilot/review-model"
import { STRINGS } from "@/lib/strings"

import { fmtUtc } from "./format"

/** Calls to review, newest first, bounded and keyset-paginated. Content-free: no transcript, number or provider id. */
export function CallReviewList({
  list, hrefFor, baseHref, nextHref, isFirstPage,
}: {
  list: ReviewList
  hrefFor: (callId: string) => string
  baseHref: string
  nextHref: string | null
  isFirstPage: boolean
}) {
  const s = STRINGS.pages.callReview
  if (list.items.length === 0 && isFirstPage) {
    return <EmptyState title={s.listEmptyTitle} description={s.listEmptyBody} />
  }
  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {list.items.map((c) => {
          const status = CAPTURE_STATUS_COPY[c.capture_status]
          const total = c.proposals?.total ?? 0
          return (
            <li key={c.call_id}>
              <Link
                href={hrefFor(c.call_id)}
                className="flex min-h-11 items-center justify-between gap-3 rounded-md bg-card p-4 ring-1 ring-border outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="min-w-0 space-y-1.5">
                  <span className="block font-medium text-foreground">Call on <span className="font-data">{fmtUtc(c.created_at)}</span></span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusPill size="sm" tone={status.tone}>{status.label}</StatusPill>
                    {c.coverage_status ? <StatusPill size="sm" tone={c.coverage_status === "complete" ? "good" : "warn"}>{c.coverage_status === "complete" ? "Complete transcript" : "Partial transcript"}</StatusPill> : <StatusPill size="sm" tone="muted">No evidence yet</StatusPill>}
                    {c.proposals && c.proposals.awaiting > 0 ? <StatusPill size="sm" tone="warn">{c.proposals.awaiting} waiting on you</StatusPill> : null}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {c.proposals === null ? "Nothing proposed yet."
                      : `${total} proposal${total === 1 ? "" : "s"} · ${c.proposals.review_only} review only · ${c.proposals.decided} decided`}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          )
        })}
      </ul>
      {list.items.length === 0 ? <p className="text-sm text-muted-foreground">No older calls.</p> : null}
      {!isFirstPage || nextHref ? (
        <Pagination label="Calls to review" previous={isFirstPage ? null : { href: baseHref, label: s.newerCalls }} next={nextHref ? { href: nextHref, label: s.olderCalls } : null} />
      ) : null}
    </div>
  )
}
