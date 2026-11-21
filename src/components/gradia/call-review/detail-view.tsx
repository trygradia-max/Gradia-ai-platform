import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react"

import { EmptyState } from "@/components/gradia/empty-state"
import { SectionHeader } from "@/components/gradia/section-header"
import { StatusPill } from "@/components/ui/status-pill"
import type { ReviewDetail } from "@/lib/call-copilot/review-dto"
import { reviewHeadline } from "@/lib/call-copilot/review-model"
import { STRINGS } from "@/lib/strings"

import { CapturePanel } from "./capture-panel"
import { EvidencePanel } from "./evidence-panel"
import { fmtUtc } from "./format"
import { ProposalList } from "./proposal-list"
import { RefreshButton } from "./refresh-button"

const TONE_ICON = { good: CheckCircle2, warn: AlertTriangle, bad: ShieldAlert, muted: AlertTriangle } as const

/**
 * The post-call review: consent and capture, evidence and gaps, then source-cited proposals. Server-rendered from the
 * validated DTO; the only interactive part is `ProposalList`. Used by the owner's dashboard route and the manager's
 * read-only team route, so both show exactly the same facts.
 */
export function CallReviewDetailView({ detail, checkedAt }: { detail: ReviewDetail; checkedAt: string }) {
  const s = STRINGS.pages.callReview
  const headline = reviewHeadline(detail)
  const Icon = TONE_ICON[headline.tone]
  const sel = detail.evidence.selected
  return (
    <div className="space-y-6">
      <SectionHeader
        level={1}
        eyebrow={s.eyebrow}
        title={`Call on ${fmtUtc(detail.call.created_at)}`}
        subhead={s.detailSubhead}
        action={<RefreshButton />}
      />

      <div role="status" className="flex flex-wrap items-start gap-3 rounded-md bg-card p-4 ring-1 ring-border">
        <StatusPill tone={headline.tone} icon={<Icon className="size-3.5" aria-hidden />}>{headline.title}</StatusPill>
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{headline.detail}</p>
        <p className="w-full text-xs text-muted-foreground">{s.checkedAt} <span className="font-data">{fmtUtc(checkedAt)}</span></p>
      </div>

      {!detail.can_approve ? (
        <p role="note" className="rounded-sm bg-muted px-3 py-2 text-sm text-muted-foreground">{s.readOnlyNotice}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <CapturePanel capture={detail.capture} />
        <EvidencePanel detail={detail} />
      </div>

      <section aria-labelledby="proposals-heading" className="space-y-4">
        <h2 id="proposals-heading" className="font-display text-xl text-foreground">{s.proposalsHeading}</h2>
        {detail.snippets_withheld && detail.proposals.length > 0 ? (
          <p role="note" className="rounded-sm bg-status-warning-bg px-3 py-2 text-sm text-status-warning-fg">{s.snippetsWithheld}</p>
        ) : null}
        {detail.proposals.length === 0 ? (
          <EmptyState title={s.proposalsEmptyTitle} description={sel ? s.proposalsEmptyBody : "No evidence has been prepared for this call yet."} />
        ) : (
          <ProposalList callId={detail.call.id} proposals={detail.proposals} viewerCanApprove={detail.can_approve} snippetsWithheld={detail.snippets_withheld} />
        )}
        {detail.proposals_truncated ? <p className="text-sm text-muted-foreground">{s.proposalsTruncated}</p> : null}
      </section>
    </div>
  )
}
