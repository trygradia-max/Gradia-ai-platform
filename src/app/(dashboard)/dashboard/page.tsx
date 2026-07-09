import { cookies } from "next/headers"

import { getCrmCleanupState } from "@/app/actions/crm-cleanup"
import { dashboardEyebrow } from "@/lib/eyebrow"
import { getChannelStatusForCurrentShop } from "@/lib/data/channels"
import { getHomeKpis } from "@/lib/data/kpis"
import { listScoredLeadsForCurrentShop } from "@/lib/data/leads"
import { AiLeadSection } from "@/components/gradia/ai-lead-section"
import { BookedToday } from "@/components/gradia/booked-today"
import { CrmCleanupCard } from "@/components/gradia/crm-cleanup-card"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { ChannelConnectionCard } from "@/components/gradia/channel-connection-card"
import { DashboardHero } from "@/components/gradia/dashboard-hero"
import { HomeFeed } from "@/components/gradia/home-feed"
import { KpiRow } from "@/components/gradia/kpi-row"
import {
  WelcomeModal,
  WELCOME_DISMISSED_COOKIE,
} from "@/components/gradia/welcome-modal"
import { LiveLeadFeed } from "@/components/gradia/live-lead-feed"
import { RevenueTiles } from "@/components/gradia/revenue-tiles"
import { RoiReceipt } from "@/components/gradia/roi-receipt"
import { TodayMoneyRows } from "@/components/gradia/today-money-rows"
import { loadTodayMoney } from "@/lib/data/today-money"
import { WhisperSuggestionQueue } from "@/components/gradia/whisper-suggestion-queue"
import { listWhisperSuggestions } from "@/app/actions/whisper-queue"
import { WhisperButton } from "@/components/gradia/whisper-button"
import { requireShop } from "@/lib/shop"

export default async function DashboardPage() {
  const shop = await requireShop()
  const [leads, channels, kpis, cleanup, cookieStore, suggestions, todayMoney] = await Promise.all([
    listScoredLeadsForCurrentShop(),
    getChannelStatusForCurrentShop(),
    getHomeKpis(),
    getCrmCleanupState(),
    cookies(),
    listWhisperSuggestions(),
    loadTodayMoney(),
  ])

  const showCleanup =
    cleanup.justConnected ||
    cleanup.health.duplicateClusters.length > 0 ||
    cleanup.health.missingContact.length > 0

  const connectedCount = channels.filter(
    (c) => c.status === "connected"
  ).length
  const welcomeDismissed =
    cookieStore.get(WELCOME_DISMISSED_COOKIE)?.value === "1"

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12 sm:space-y-16">
      <WelcomeModal
        connectedCount={connectedCount}
        totalChannels={channels.length}
        initialDismissed={welcomeDismissed}
      />

      <DashboardHero
        shopName={shop.name}
        liveChannelCount={connectedCount}
        totalChannels={channels.length}
        eyebrow={dashboardEyebrow()}
        rightSlot={<AddLeadDialog />}
      />

      {/* C6a: Whisper's staged suggestions sit at the very top (run-doc
          rail: "nudges/suggestions at TOP") — the receipt keeps its pinned
          slot immediately after and is never displaced by anything else.
          Renders nothing when the queue is empty. */}
      <WhisperSuggestionQueue initial={suggestions} />

      {/* Home composition per spec §8-A5, top to bottom: the receipt is
          pinned first (sacred — the #1 retention lever, NOW-3), then the
          KPI row, then today's bookings (schedule's approved home), then
          recent activity. Co-owner nudges are OFF Home — they return
          post-alpha inline-in-context via the nudge engine (§8-A8). */}
      <RoiReceipt />

      <KpiRow kpis={kpis} />

      <BookedToday />

      {/* C8 — money + leak rows BELOW the receipt/KPIs/schedule (spec
          ordering held); every tile nonzero-rendered, every number SQL. */}
      <TodayMoneyRows data={todayMoney} />

      {showCleanup && (
        <CrmCleanupCard
          health={cleanup.health}
          justConnected={cleanup.justConnected}
        />
      )}

      {/* Recent activity — what's waiting on a yes + what just happened.
          The full glass-box feed is the L4 /activity work. */}
      <HomeFeed />

      <RevenueTiles />

      <WhisperButton />

      <AiLeadSection />

      <LiveLeadFeed leads={leads} />

      <ChannelConnectionCard channels={channels} />
    </div>
  )
}
