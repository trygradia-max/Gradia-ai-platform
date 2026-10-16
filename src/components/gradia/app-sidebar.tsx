"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  CalendarDays,
  Activity,
  Contact,
  CreditCard,
  Headset,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  Users,
  Sparkles,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarRail,
} from "@/components/ui/sidebar"
import { ShopSwitcher } from "@/components/gradia/shop-switcher"
import type { ShopContext } from "@/lib/shop"
import { cn } from "@/lib/utils"

type NavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
}

// The final IA (redesign spec §8-A4) — exactly these seven, in this order,
// plus the two pinned at the bottom. Old routes (/agents, /agent, /chat,
// /leads, /recovery, /schedule) live on as redirects, never as nav items.
// The ⌘K / Whisper command bar stays the primary composer — a verb, not a
// place.
const nav: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/approvals", label: "Approvals", icon: Inbox },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare },
  { href: "/customers", label: "Customers", icon: Contact },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/receptionist", label: "Receptionist", icon: Headset },
  ...(process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT === "true"
    ? [{ href: "/employees", label: "Digital employees", icon: Sparkles }] : []),
]

const pinnedNav: NavItem[] = [
  { href: "/team", label: "Team & assigned work", icon: Users },
  { href: "/billing", label: "Numbers & Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
]

export function AppSidebar({
  shops = [],
  activeShopId,
  approvalsCount = 0,
}: {
  shops?: ShopContext[]
  activeShopId?: string
  approvalsCount?: number
} = {}) {
  const pathname = usePathname()

  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-sidebar-border/80 transition-[width] duration-200 ease-out"
    >
      <SidebarHeader className="space-y-3 border-b border-sidebar-border/60 p-4">
        {/* Entrance animation removed 2026-07-13 — dashboard chrome renders
            in place (BUILD_REFERENCE §1: dashboards stay calm). */}
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25 transition-colors duration-(--duration-fast)">
            <Sparkles className="size-4" aria-hidden />
          </div>
          <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
            <span className="font-display text-base tracking-tight text-sidebar-foreground">
              Gradia
            </span>
            <span className="text-[11px] text-muted-foreground">
              Your AI office
            </span>
          </div>
        </div>
        {shops.length > 1 && activeShopId ? (
          <ShopSwitcher shops={shops} activeShopId={activeShopId} />
        ) : null}
      </SidebarHeader>

      <SidebarContent className="px-2 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="label-eyebrow text-muted-foreground group-data-[collapsible=icon]:opacity-0 transition-opacity duration-(--duration-fast)">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((item) => {
                const isActive =
                  item.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : pathname.startsWith(item.href)

                return (
                  <NavRow
                    key={item.href}
                    item={item}
                    isActive={isActive}
                    badge={item.href === "/approvals" ? approvalsCount : 0}
                  />
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Pinned bottom (spec §8-A4): Numbers & Billing · Settings. */}
      <SidebarFooter className="border-t border-sidebar-border/60 px-2 py-3">
        <SidebarMenu>
          {pinnedNav.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              isActive={pathname.startsWith(item.href)}
            />
          ))}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function NavRow({
  item,
  isActive,
  badge = 0,
}: {
  item: NavItem
  isActive: boolean
  badge?: number
}) {
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      {/* Static current-page rail. The previous motion morph mismatched
          server/client markup. */}
      <div className="relative">
        {isActive ? (
          <span
            className="pointer-events-none absolute left-0 top-1/2 z-20 h-5 w-[2px] -translate-y-1/2 rounded-full bg-ring"
            aria-hidden
          />
        ) : null}
        {isActive ? (
          <span
            className="pointer-events-none absolute inset-0 rounded-md bg-sidebar-accent/90"
            aria-hidden
          />
        ) : null}

        <SidebarMenuButton
          isActive={isActive}
          tooltip={item.label}
          className={cn(
            // Suppress the built-in flat active background — the
            // static rail/fill above already provides it.
            "relative bg-transparent! data-active:bg-transparent!",
            "transition-colors duration-(--duration-fast)",
            isActive
              ? "text-sidebar-accent-foreground"
              : "text-sidebar-foreground/80 hover:text-sidebar-accent-foreground"
          )}
          render={<Link href={item.href} />}
        >
          <Icon
            className={cn(
              "transition-colors duration-(--duration-fast)",
              isActive
                ? "text-primary"
                : "text-sidebar-foreground/70 group-hover/menu-item:text-sidebar-accent-foreground"
            )}
            aria-hidden
          />
          <span className="font-medium">{item.label}</span>
          {badge > 0 ? (
            <span
              className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold tabular-nums text-accent-text group-data-[collapsible=icon]:hidden"
              aria-label={`${badge} awaiting approval`}
            >
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </SidebarMenuButton>
      </div>
    </SidebarMenuItem>
  )
}
