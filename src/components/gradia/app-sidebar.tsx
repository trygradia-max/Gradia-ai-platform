"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { motion, useReducedMotion } from "framer-motion"
import {
  Contact,
  Inbox,
  LayoutDashboard,
  Settings,
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
  SidebarRail,
} from "@/components/ui/sidebar"
import { ShopSwitcher } from "@/components/gradia/shop-switcher"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import type { ShopContext } from "@/lib/shop"
import { cn } from "@/lib/utils"

type NavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
}

// Three sturdy destinations + Settings (FOCUS spec §4.4). Ask Gradia is the
// ⌘K command bar, not a place; Leads folds into Customers, Schedule into
// Home/Customers, and "What Gradia does" (/agents) drops off the primary nav.
// All those routes still exist — they're just no longer top-level.
const nav: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/approvals", label: "Approvals", icon: Inbox },
  { href: "/customers", label: "Customers", icon: Contact },
  { href: "/settings", label: "Settings", icon: Settings },
]

/** Shared across all active-state pieces so layoutId morphs together. */
const ACTIVE_BG_LAYOUT_ID = "sidebar-nav-active-bg"
const ACTIVE_RAIL_LAYOUT_ID = "sidebar-nav-active-rail"

const ACTIVE_SPRING = { type: "spring" as const, stiffness: 380, damping: 32 }

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

  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-sidebar-border/80 transition-[width] duration-200 ease-out"
    >
      <SidebarHeader className="space-y-3 border-b border-sidebar-border/60 p-4">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
          className="flex items-center gap-2.5"
        >
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/12 text-primary ring-1 ring-primary/25 transition-colors duration-200">
            <Sparkles className="size-4" aria-hidden />
          </div>
          <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
            <span className="font-display text-base tracking-tight text-sidebar-foreground">
              Gradia
            </span>
            <span className="text-[11px] text-muted-foreground/80">
              Your AI office
            </span>
          </div>
        </motion.div>
        {shops.length > 1 && activeShopId ? (
          <ShopSwitcher shops={shops} activeShopId={activeShopId} />
        ) : null}
      </SidebarHeader>

      <SidebarContent className="px-2 py-4">
        <SidebarGroup>
          <SidebarGroupLabel className="label-eyebrow !text-muted-foreground/70 group-data-[collapsible=icon]:opacity-0 transition-opacity duration-200">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((item, index) => {
                const isActive =
                  item.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : pathname.startsWith(item.href)

                return (
                  <NavRow
                    key={item.href}
                    item={item}
                    isActive={isActive}
                    index={index}
                    reduce={reduce ?? false}
                    badge={item.href === "/approvals" ? approvalsCount : 0}
                  />
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}

function NavRow({
  item,
  isActive,
  index,
  reduce,
  badge = 0,
}: {
  item: NavItem
  isActive: boolean
  index: number
  reduce: boolean
  badge?: number
}) {
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      <motion.div
        initial={reduce ? false : { opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{
          duration: 0.4,
          ease: EASE_OUT_EXPO,
          delay: reduce ? 0 : 0.06 + index * 0.035,
        }}
        className="relative"
      >
        {/* Active rail — slides between items via layoutId. The thin
         *  accent edge is what reads as the "current page" indicator.
         *  We render this only on the active row; Framer Motion uses
         *  layoutId to morph it between rows on navigation. */}
        {isActive ? (
          <motion.span
            layoutId={ACTIVE_RAIL_LAYOUT_ID}
            transition={reduce ? { duration: 0 } : ACTIVE_SPRING}
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
            transition={reduce ? { duration: 0 } : ACTIVE_SPRING}
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
            "transition-colors duration-200",
            isActive
              ? "text-sidebar-accent-foreground"
              : "text-sidebar-foreground/80 hover:text-sidebar-accent-foreground"
          )}
          render={<Link href={item.href} />}
        >
          <Icon
            className={cn(
              "transition-colors duration-200",
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
      </motion.div>
    </SidebarMenuItem>
  )
}
