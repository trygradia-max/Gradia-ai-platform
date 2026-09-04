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
  const [channels, kpis, approvals, activity] = await Promise.all([
    getChannelStatusForCurrentShop(),
    getHomeKpis(),
    listOpenApprovalsForCurrentShop(),
    listActivityFeed(),
  ])

  const connectedCount = channels.filter((c) => c.status === "connected").length
  const editCount = approvals.filter((a) => a.status === "edit_requested").length
  const pendingCount = approvals.length - editCount
  const a = STRINGS.pages.approvals
  const v = STRINGS.pages.activity

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12 sm:space-y-16">
      <DashboardHero
        shopName={shop.name}
        liveChannelCount={connectedCount}
        totalChannels={channels.length}
        eyebrow={dashboardEyebrow()}
        rightSlot={<AddLeadDialog />}
      />

      <KpiRow kpis={kpis} />

      <section className="space-y-5">
        <SectionHeader
          eyebrow={STRINGS.chrome.waitingOnYou}
          title={approvals.length === 0 ? `${a.titleAllClear}.` : `${a.titleWaiting}.`}
          subhead={
            approvals.length === 0
              ? a.subtitleEmpty
              : a.subtitleWaiting(pendingCount, editCount)
          }
        />
        <ApprovalsList items={approvals} />
      </section>

      <section className="space-y-5">
        <SectionHeader eyebrow={v.eyebrow} title={v.title} subhead={v.subtitle} />
        <ActivityFeed items={activity} />
      </section>
    </div>
  )
}
