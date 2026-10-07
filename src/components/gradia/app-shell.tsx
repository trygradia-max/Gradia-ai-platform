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

export const dynamic = "force-dynamic"

/**
 * Shared desk chrome. `flush` drops page padding so Inbox can use the
 * full pane (list stays put, the thread scrolls beside it).
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

  // First-run gate only. A free shop can explore; running and sending
  // fail closed downstream. /onboarding lives outside this shell.
  if (active) {
    const supabase = await createClient()
    const { data } = await supabase
      .from("shops")
      .select("settings")
      .eq("id", active.id)
      .single()
    const row = (data as { settings?: Record<string, unknown> } | null) ?? null
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
      <SidebarInset
        className={cn(
          "min-h-svh overflow-x-hidden",
          flush && "h-svh max-h-svh overflow-hidden"
        )}
      >
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/80 bg-background/85 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/65 sm:px-4">
          <SidebarTrigger className="-ml-0.5" />
          <PageTitle />
          <div className="pointer-events-none absolute inset-x-0 hidden justify-center lg:flex">
            <div className="pointer-events-auto w-full max-w-md px-4">
              <AskGradiaButton wide />
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="lg:hidden">
              <AskGradiaButton />
            </div>
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
        <div
          className={
            flush
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "flex flex-1 flex-col gap-8 p-4 pb-28 sm:p-6 sm:pb-6"
          }
        >
          {children}
        </div>
      </SidebarInset>
      <CommandBar />
      <MobileComposer />
    </SidebarProvider>
  )
}
