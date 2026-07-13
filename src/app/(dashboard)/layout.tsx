import { redirect } from "next/navigation"
import { CircleHelp } from "lucide-react"

import { needsOnboarding } from "@/lib/onboarding"

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/gradia/app-sidebar"
import { AskGradiaButton } from "@/components/gradia/ask-gradia-button"
import { CommandBar } from "@/components/gradia/command-bar"
import { MobileComposer } from "@/components/gradia/mobile-composer"
import { PageTitle } from "@/components/gradia/page-title"
import { SetupProgressPill } from "@/components/gradia/setup-progress-pill"
import { UsagePill } from "@/components/gradia/usage-pill"
import { countOpenApprovalsForCurrentShop } from "@/lib/data/pending-actions"
import { getOptionalShop, listShopsForCurrentUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [shops, active, approvalsCount] = await Promise.all([
    listShopsForCurrentUser(),
    getOptionalShop(),
    countOpenApprovalsForCurrentShop(),
  ])

  // First-run gate only. Per GRADIA_PRICING.md, a free (pre-subscription) shop
  // "can explore, cannot run agents or send" — so there is NO paywall redirect
  // here. Running/sending is gated downstream and fails closed (the chat box at
  // api/agent/chat via checkFeatureAccess, and the runtime via isPaid), so
  // exploring the dashboard is safe without an active plan. /onboarding lives
  // outside this layout group so the redirect can't loop.
  if (active) {
    const supabase = await createClient()
    const { data } = await supabase
      .from("shops")
      .select("settings")
      .eq("id", active.id)
      .single()
    const row = (data as { settings?: Record<string, unknown> } | null) ?? null
    // New shops see the wizard until they finish/skip it (UX spec Part 1).
    // Shops from before the flag (no key) are never gated.
    if (needsOnboarding(row?.settings)) {
      redirect("/onboarding")
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar
        shops={shops}
        activeShopId={active?.id}
        approvalsCount={approvalsCount}
      />
      <SidebarInset className="min-h-svh overflow-x-hidden">
        {/* Topbar (spec §3): page title · search/composer (⌘K) · usage
            pill in human units · help. No secondary nav rows. */}
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/80 bg-background/85 px-4 backdrop-blur-md transition-colors duration-200 supports-[backdrop-filter]:bg-background/65">
          <SidebarTrigger className="-ml-0.5" />
          <PageTitle />
          <div className="ml-auto flex items-center gap-2">
            <AskGradiaButton />
            <UsagePill />
            <SetupProgressPill />
            <a
              href="/how-it-works"
              aria-label="Help — how Gradia works"
              className="flex size-8 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              <CircleHelp className="size-4" aria-hidden />
            </a>
          </div>
        </header>
        {/* Extra bottom padding on mobile so the fixed composer never covers
            the last card. */}
        <div className="flex flex-1 flex-col gap-8 p-6 pb-28 sm:pb-6">
          {children}
        </div>
      </SidebarInset>

      {/* Gradia Agent everywhere: ⌘K / top-bar overlay (desktop) + the
          bottom-anchored tap-to-talk composer (mobile). */}
      <CommandBar />
      <MobileComposer />
    </SidebarProvider>
  )
}
