import { loadIntakeReview } from "@/lib/data/intake-review"
import { createClient } from "@/lib/supabase/server"
import { IntakeReviewQueue } from "@/components/gradia/intake-review-queue"
import { getChannelStatusForCurrentShop } from "@/lib/data/channels"
import { getHomeKpis } from "@/lib/data/kpis"
import { listActivityFeed } from "@/lib/data/activity"
import { listOpenApprovalsForCurrentShop } from "@/lib/data/pending-actions"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { ActivityFeed } from "@/components/gradia/activity-feed"
import { ApprovalsList } from "@/components/gradia/approvals-list"
import { DashboardHero } from "@/components/gradia/dashboard-hero"
import { KpiRow } from "@/components/gradia/kpi-row"
import { SectionHeader } from "@/components/gradia/section-header"
import { dashboardEyebrow } from "@/lib/eyebrow"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"

/**
 * B-03 — Chief of Staff. REPLACES the old Home outright (U-01: 14 stacked
 * components, four money surfaces, three feeds). This page is exactly four
 * things, top to bottom: one hero line, one small KPI row, one needs-you
 * queue, one activity stream. `/approvals` and `/activity` still exist as
 * standalone routes (nav cut is B-14) but their data now renders here too —
 * this IS the "what do I do now" answer (§4d U-03).
 */
export default async function DashboardPage() {
  const shop = await requireShop()
  const db = await createClient()
  const [channels, kpis, approvals, activity, intake] = await Promise.all([
    getChannelStatusForCurrentShop(),
    getHomeKpis(),
    listOpenApprovalsForCurrentShop(),
    listActivityFeed(),
    loadIntakeReview(db, shop.id, 0, 5),
  ])

  const connectedCount = channels.filter((c) => c.status === "connected").length
  const editCount = approvals.filter((a) => a.status === "edit_requested").length
  const pendingCount = approvals.length - editCount
  const a = STRINGS.pages.approvals
  const v = STRINGS.pages.activity

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <DashboardHero
        shopName={shop.name}
        liveChannelCount={connectedCount}
        totalChannels={channels.length}
        eyebrow={dashboardEyebrow()}
        status={
          approvals.length === 0
            ? "Nothing needs you right now."
            : `${approvals.length} waiting on you.`
        }
        rightSlot={<AddLeadDialog />}
      />

      <KpiRow kpis={kpis} />

      <section className="space-y-5">
        <SectionHeader
          eyebrow={STRINGS.chrome.waitingOnYou}
          title={approvals.length === 0 && intake.ok && intake.queue.total === 0 ? `${a.titleAllClear}.` : "Needs your review."}
          subhead={
            approvals.length === 0
              ? (!intake.ok ? "Intake status is unavailable. Check the queue below." : intake.queue.total > 0 ? "No approvals waiting, but incoming details still need identity review." : a.subtitleEmpty)
              : a.subtitleWaiting(pendingCount, editCount)
          }
        />
        <ApprovalsList items={approvals} />
        <IntakeReviewQueue result={intake} shopId={shop.id} compact/>
      </section>

      <section className="space-y-5">
        <SectionHeader eyebrow={v.eyebrow} title={v.title} subhead={v.subtitle} />
        <ActivityFeed items={activity} />
      </section>
    </div>
  )
}
