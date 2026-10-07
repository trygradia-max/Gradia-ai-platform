"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion, useReducedMotion } from "framer-motion"
import {
  CalendarDays,
  Activity,
  Contact,
  CreditCard,
  Headset,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Settings,
  Users,
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

// Daily destinations first. Approvals and Activity stay one click away
// (they also render on Home). Routes are unchanged.
const workspace: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/conversations", label: "Inbox", icon: Inbox },
  { href: "/customers", label: "Customers", icon: Contact },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/receptionist", label: "Receptionist", icon: Headset },
]

const review: NavItem[] = [
  { href: "/approvals", label: "Approvals", icon: ListChecks },
  { href: "/activity", label: "Activity", icon: Activity },
]

const pinnedNav: NavItem[] = [
  { href: "/team", label: "Team & assigned work", icon: Users },
  { href: "/billing", label: "Numbers & Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
]

/** Shared across all active-state pieces so layoutId morphs together. */
const ACTIVE_BG_LAYOUT_ID = "sidebar-nav-active-bg"
const ACTIVE_RAIL_LAYOUT_ID = "sidebar-nav-active-rail"

// Functional feedback stays within the 100–150ms cap (BUILD_REFERENCE §1);
// the previous spring morph read as cinematic on dashboard chrome.
const ACTIVE_TWEEN = { duration: 0.15, ease: "easeOut" as const }

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
  const reduce = useReducedMotion()
  const shopName = shops.find((s) => s.id === activeShopId)?.name

  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-sidebar-border/80 transition-[width] duration-200 ease-out"
    >
      <SidebarHeader className="space-y-3 border-b border-sidebar-border/60 p-4">
        {/* Entrance animation removed 2026-07-13 — dashboard chrome renders
            in place (BUILD_REFERENCE §1: dashboards stay calm). */}
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
            G
          </div>
          <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
            <span className="font-display text-sm tracking-tight text-sidebar-foreground">
              Gradia
            </span>
            <span className="truncate text-[11px] text-muted-foreground/80">
              {shopName ?? "Your shop"}
            </span>
          </div>
        </div>
        {shops.length > 1 && activeShopId ? (
          <ShopSwitcher shops={shops} activeShopId={activeShopId} />
        ) : null}
      </SidebarHeader>

      <SidebarContent className="px-2 py-4">
        <NavGroup
          label="Workspace"
          items={workspace}
          pathname={pathname}
          reduce={reduce ?? false}
        />
        <NavGroup
          label="Review"
          items={review}
          pathname={pathname}
          reduce={reduce ?? false}
          badgeFor="/approvals"
          badge={approvalsCount}
        />
      </SidebarContent>

      {/* Pinned bottom (spec §8-A4): Numbers & Billing · Settings. */}
      <SidebarFooter className="border-t border-sidebar-border/60 px-2 py-3">
        <SidebarMenu>
          {pinnedNav.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              isActive={pathname.startsWith(item.href)}
              reduce={reduce ?? false}
            />
          ))}
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function NavGroup({
  label,
  items,
  pathname,
  reduce,
  badge = 0,
  badgeFor,
}: {
  label: string
  items: NavItem[]
  pathname: string
  reduce: boolean
  badge?: number
  badgeFor?: string
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="label-eyebrow !text-muted-foreground/70 transition-opacity duration-(--duration-fast) group-data-[collapsible=icon]:opacity-0">
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              isActive={
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href)
              }
              reduce={reduce}
              badge={item.href === badgeFor ? badge : 0}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function NavRow({
  item,
  isActive,
  reduce,
  badge = 0,
}: {
  item: NavItem
  isActive: boolean
  reduce: boolean
  badge?: number
}) {
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      {/* Per-item entrance stagger removed 2026-07-13 — nav chrome renders
          in place (BUILD_REFERENCE §1). The layoutId rail morph below stays:
          it's functional current-page feedback, now on a ≤150ms tween. */}
      <div className="relative">
        {/* Active rail — slides between items via layoutId. The thin
         *  accent edge is what reads as the "current page" indicator.
         *  We render this only on the active row; Framer Motion uses
         *  layoutId to morph it between rows on navigation. */}
        {isActive ? (
          <motion.span
            layoutId={ACTIVE_RAIL_LAYOUT_ID}
            transition={reduce ? { duration: 0 } : ACTIVE_TWEEN}
            className="pointer-events-none absolute left-0 top-1/2 z-20 h-5 w-[2px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_0_var(--color-primary)]"
            aria-hidden
          />
        ) : null}

        {/* Active background — a softer rounded fill that also morphs
         *  between items. Sits beneath the button so the row reads as
         *  one continuous surface, not a stacked highlight. */}
        {isActive ? (
          <motion.span
            layoutId={ACTIVE_BG_LAYOUT_ID}
            transition={reduce ? { duration: 0 } : ACTIVE_TWEEN}
            className="pointer-events-none absolute inset-0 rounded-md bg-sidebar-accent/90"
            aria-hidden
          />
        ) : null}

        <SidebarMenuButton
          isActive={isActive}
          tooltip={item.label}
          className={cn(
            // Suppress the built-in flat active background — our
            // motion.span above already provides it (and animates).
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
              className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold tabular-nums text-primary group-data-[collapsible=icon]:hidden"
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
