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
import { cn } from "@/lib/utils"

/**
 * Shared desk chrome. `flush` drops page padding so Inbox can keep the
 * conversation list beside the thread. The first-run gate matches the
 * owner dashboard: a shop still in onboarding goes to the wizard. A
 * session with no owned shop is not redirected.
 */
export async function AppShell({
  children,
  flush = false,
}: {
  children: React.ReactNode
  flush?: boolean
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
    <SidebarProvider className={flush ? "lg:h-svh lg:overflow-hidden" : undefined}>
      <AppSidebar
        shops={shops}
        activeShopId={active?.id}
        approvalsCount={approvalsCount}
      />
      <SidebarInset
        className={cn(
          "min-h-svh overflow-x-hidden",
          flush && "lg:h-svh lg:max-h-svh lg:overflow-hidden"
        )}
      >
        {/* Topbar (spec §3): page title · search/composer (⌘K) · usage
            pill in human units · help. The composer sits in the center
            from the lg breakpoint up so it does not share a cluster with
            usage, setup, and help. */}
        <header className="sticky top-0 z-10 grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border/80 bg-background/85 px-3 backdrop-blur-md transition-colors duration-200 supports-[backdrop-filter]:bg-background/65 sm:px-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="size-11 shrink-0" />
            <div className="min-w-0">
              <PageTitle />
            </div>
          </div>
          <div className="hidden min-w-0 justify-center lg:flex">
            <AskGradiaButton wide />
          </div>
          <div className="flex items-center justify-end gap-2">
            <div className="lg:hidden">
              <AskGradiaButton />
            </div>
            <UsagePill />
            <SetupProgressPill />
            <a
              href="/how-it-works"
              aria-label="Help — how Gradia works"
              className="flex size-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <CircleHelp className="size-4" aria-hidden />
            </a>
          </div>
        </header>
        {/* Extra bottom padding on small screens so the fixed composer never
            covers the last card. Flush inbox pages scroll inside their panes
            from the lg breakpoint up. */}
        <div
          className={
            flush
              ? "flex min-h-0 flex-1 flex-col overflow-x-hidden pb-28 lg:overflow-hidden lg:pb-0"
              : "flex flex-1 flex-col gap-8 p-6 pb-28 sm:pb-6"
          }
        >
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
