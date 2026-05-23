import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/gradia/app-sidebar"
import { SetupProgressPill } from "@/components/gradia/setup-progress-pill"
import { getOptionalShop, listShopsForCurrentUser } from "@/lib/shop"

export const dynamic = "force-dynamic"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [shops, active] = await Promise.all([
    listShopsForCurrentUser(),
    getOptionalShop(),
  ])

  return (
    <SidebarProvider>
      <AppSidebar shops={shops} activeShopId={active?.id} />
      <SidebarInset className="min-h-svh overflow-x-hidden">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-border/80 bg-background/85 px-4 backdrop-blur-md transition-colors duration-200 supports-[backdrop-filter]:bg-background/65">
          <SidebarTrigger className="-ml-0.5" />
          <span className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
            Gradia
          </span>
          <div className="ml-auto">
            <SetupProgressPill />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-8 p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
