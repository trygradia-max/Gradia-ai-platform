import { cookies } from "next/headers"

import { dashboardEyebrow } from "@/lib/eyebrow"
import { getChannelStatusForCurrentShop } from "@/lib/data/channels"
import { getCoOwnerSuggestions } from "@/lib/data/co-owner"
import { listScoredLeadsForCurrentShop } from "@/lib/data/leads"
import { AiLeadSection } from "@/components/gradia/ai-lead-section"
import { AddLeadDialog } from "@/components/gradia/add-lead-dialog"
import { ChannelConnectionCard } from "@/components/gradia/channel-connection-card"
import { CoOwnerCard } from "@/components/gradia/co-owner-card"
import { DashboardHero } from "@/components/gradia/dashboard-hero"
import {
  WelcomeModal,
  WELCOME_DISMISSED_COOKIE,
} from "@/components/gradia/welcome-modal"
import { LiveLeadFeed } from "@/components/gradia/live-lead-feed"
import { RevenueTiles } from "@/components/gradia/revenue-tiles"
import { WhisperButton } from "@/components/gradia/whisper-button"
import { requireShop } from "@/lib/shop"

export default async function DashboardPage() {
  const shop = await requireShop()
  const [leads, channels, suggestions, cookieStore] = await Promise.all([
    listScoredLeadsForCurrentShop(),
    getChannelStatusForCurrentShop(),
    getCoOwnerSuggestions(),
    cookies(),
  ])

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

      {/* Nudges first — "what I'd tackle next" beats a wall of stats
          (GRADIA_UX_ONBOARDING_SPEC Part 2). */}
      <CoOwnerCard suggestions={suggestions} />

      <RevenueTiles />

      <WhisperButton />

      <AiLeadSection />

      <LiveLeadFeed leads={leads} />

      <ChannelConnectionCard channels={channels} />
    </div>
  )
}
