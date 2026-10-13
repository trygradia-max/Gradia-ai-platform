import Link from "next/link"

import { EmptyState } from "@/components/gradia/empty-state"
import { ErrorState } from "@/components/gradia/error-state"
import { ReviewCard } from "@/components/gradia/review-card"
import { StatusPill } from "@/components/ui/status-pill"
import type { LeadQualificationList } from "@/lib/lead-qualification"
import {
  QUALIFICATION_REVIEW_REASON_COPY,
  QUALIFICATION_REVIEW_STATE_LABELS,
  qualificationIdentityLine,
  qualificationUpdatedAt,
} from "@/lib/qualification-review"

const reviewLink =
  "inline-flex min-h-11 items-center text-sm text-accent-text underline-offset-4 hover:underline"

function reviewTone(state: LeadQualificationList["items"][number]["review_state"]) {
  if (state === "needs_review") return "warn" as const
  if (state === "reviewed") return "good" as const
  if (state === "in_progress") return "accent" as const
  return "muted" as const
}

export function QualificationList({
  result,
  shopId,
}: {
  result: { ok: true; data: LeadQualificationList } | { ok: false }
  shopId: string
}) {
  if (!result.ok) {
    return (
      <section aria-label="Qualification review" className="space-y-4">
        <h2 className="font-display text-xl text-foreground">Qualification review</h2>
        <ErrorState
          compact
          title="Qualification could not be loaded. Refresh or ask the owner to check your access. This does not mean there are no records."
        />
      </section>
    )
  }
  const items = result.data.items.slice(0, 20)
  return (
    <section aria-label="Qualification review" className="space-y-4">
      <h2 className="font-display text-xl text-foreground">Qualification review</h2>
      <p className="text-sm text-muted-foreground">
        Linked intake that already has a qualification document, or is ready for one. Unknown stays
        unknown. Viewing does not quote, book, message, or grant consent.
        {result.data.can_update
          ? " You can save reviewed details."
          : " Your grant is read-only; saving requires the owner or a manager qualify grant."}
      </p>
      {items.length === 0 ? (
        <EmptyState
          title="No qualification records on this page."
          description="Identity-linked intake appears here after a customer is linked. Unresolved submissions stay in identity review above."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.workflow_id}>
              <ReviewCard
                eyebrow={item.channel.replaceAll("_", " ")}
                title={qualificationIdentityLine(item.identity)}
                status={
                  <span className="flex flex-wrap gap-2">
                    <StatusPill tone={reviewTone(item.review_state)}>
                      {QUALIFICATION_REVIEW_STATE_LABELS[item.review_state]}
                    </StatusPill>
                    <StatusPill tone={item.completeness === "complete" ? "good" : "muted"}>
                      {item.completeness === "complete" ? "Complete" : "Incomplete"}
                    </StatusPill>
                  </span>
                }
                evidence={
                  <>
                    <p>
                      Revision {item.revision}
                      {item.updated_at
                        ? ` · Last recorded ${qualificationUpdatedAt(item.updated_at)}`
                        : " · Nothing recorded yet"}
                      {item.updated_by
                        ? ` · ${item.updated_by.label} (${item.updated_by.role})`
                        : ""}
                    </p>
                    {item.review_state === "needs_review" ? (
                      <p role="status">
                        Stale:{" "}
                        {item.review_reasons
                          .map((reason) => QUALIFICATION_REVIEW_REASON_COPY[reason])
                          .join(" ")}
                      </p>
                    ) : null}
                    {item.missing.length > 0 ? (
                      <p>Missing: {item.missing.map((name) => name.replaceAll("_", " ")).join(", ")}.</p>
                    ) : (
                      <p>No missing fields. That is not a quote or booking ready state.</p>
                    )}
                  </>
                }
                actions={
                  <Link
                    href={`/intake/${item.workflow_id}?shop=${shopId}#qualification`}
                    className={reviewLink}
                  >
                    {result.data.can_update ? "Review qualification" : "View qualification"}
                  </Link>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
