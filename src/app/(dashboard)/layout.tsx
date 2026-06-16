import { redirect } from "next/navigation"
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
import { SetupProgressPill } from "@/components/gradia/setup-progress-pill"
import { countOpenApprovalsForCurrentShop } from "@/lib/data/pending-actions"
import { FEATURES } from "@/lib/features"
import { getOptionalShop, listShopsForCurrentUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopPlan } from "@/lib/types/database"

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

  // Paywall + first-run gates. /billing and /onboarding live outside this
  // layout group so the redirects can't loop.
  if (active) {
    const supabase = await createClient()
    const { data } = await supabase
      .from("shops")
      .select("plan, settings")
      .eq("id", active.id)
      .single()
    const row =
      (data as { plan: ShopPlan; settings?: Record<string, unknown> } | null) ??
      null
    if (FEATURES.paywall && row?.plan !== "active") {
      redirect("/billing")
    }
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
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/80 bg-background/85 px-4 backdrop-blur-md transition-colors duration-200 supports-[backdrop-filter]:bg-background/65">
          <SidebarTrigger className="-ml-0.5" />
          <span className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
            Gradia
          </span>
          <div className="ml-auto flex items-center gap-2">
            <AskGradiaButton />
            <SetupProgressPill />
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
