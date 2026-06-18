import { cookies } from "next/headers"

import { getCrmCleanupState } from "@/app/actions/crm-cleanup"
import { dashboardEyebrow } from "@/lib/eyebrow"
import { getChannelStatusForCurrentShop } from "@/lib/data/channels"
import { getCoOwnerSuggestions } from "@/lib/data/co-owner"
import { listScoredLeadsForCurrentShop } from "@/lib/data/leads"
import { AiLeadSection } from "@/components/gradia/ai-lead-section"
import { CrmCleanupCard } from "@/components/gradia/crm-cleanup-card"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { ChannelConnectionCard } from "@/components/gradia/channel-connection-card"
import { CoOwnerCard } from "@/components/gradia/co-owner-card"
import { DashboardHero } from "@/components/gradia/dashboard-hero"
import { HomeFeed } from "@/components/gradia/home-feed"
import {
  WelcomeModal,
  WELCOME_DISMISSED_COOKIE,
} from "@/components/gradia/welcome-modal"
import { LiveLeadFeed } from "@/components/gradia/live-lead-feed"
import { RevenueTiles } from "@/components/gradia/revenue-tiles"
import { RoiReceipt } from "@/components/gradia/roi-receipt"
import { WhisperButton } from "@/components/gradia/whisper-button"
import { requireShop } from "@/lib/shop"

export default async function DashboardPage() {
  const shop = await requireShop()
  const [leads, channels, suggestions, cleanup, cookieStore] = await Promise.all([
    listScoredLeadsForCurrentShop(),
    getChannelStatusForCurrentShop(),
    getCoOwnerSuggestions(),
    getCrmCleanupState(),
    cookies(),
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

      {/* The receipt is pinned on top — the proof of why we're worth it, the
          #1 retention lever (FOCUS spec §4.3 / NOW-3). Always visible, even
          at zero (it carries its own written empty state). */}
      <RoiReceipt />

      {/* Nudges next — "what I'd tackle next" beats a wall of stats
          (GRADIA_UX_ONBOARDING_SPEC Part 2). */}
      {showCleanup && (
        <CrmCleanupCard
          health={cleanup.health}
          justConnected={cleanup.justConnected}
        />
      )}
      <CoOwnerCard suggestions={suggestions} />

      {/* The live feed — what's waiting on a yes + what we've handled. Sits
          right under the nudges so the daily loop (glance → approve) happens
          on Home (FOCUS spec §4.3, item 3). */}
      <HomeFeed />

      <RevenueTiles />

      <WhisperButton />

      <AiLeadSection />

      <LiveLeadFeed leads={leads} />

      <ChannelConnectionCard channels={channels} />
    </div>
  )
}
