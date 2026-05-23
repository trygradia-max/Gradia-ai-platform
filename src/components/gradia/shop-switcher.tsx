"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, ChevronsUpDown, Plus, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { setActiveShop } from "@/app/actions/shop"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ShopContext } from "@/lib/shop"

export function ShopSwitcher({
  shops,
  activeShopId,
}: {
  shops: ShopContext[]
  activeShopId: string
}) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const active = shops.find((s) => s.id === activeShopId) ?? shops[0]
  if (!active) return null

  async function handleSwitch(shopId: string) {
    if (shopId === activeShopId || pending) return
    setPending(true)
    const result = await setActiveShop(shopId)
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    router.refresh()
  }

  // Only render the switcher when there's actually a choice. Single-
  // shop accounts still get the static header above this in
  // app-sidebar.tsx; this component just no-ops.
  if (shops.length <= 1) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border border-sidebar-border/60 bg-sidebar-accent/30 px-2 py-1.5 text-left transition hover:bg-sidebar-accent/50 group-data-[collapsible=icon]:hidden"
          />
        }
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
          <Sparkles className="size-3.5" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <p className="truncate text-xs font-medium text-sidebar-foreground">
            {active.name}
          </p>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {shops.length} shops
          </p>
        </div>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Switch shop
        </DropdownMenuLabel>
        {shops.map((shop) => {
          const isActive = shop.id === active.id
          return (
            <DropdownMenuItem
              key={shop.id}
              onClick={() => handleSwitch(shop.id)}
              disabled={pending}
              className="flex items-center gap-2"
            >
              <div className="flex size-5 items-center justify-center">
                {isActive ? (
                  <Check className="size-3.5 text-primary" aria-hidden />
                ) : null}
              </div>
              <span className="flex-1 truncate text-sm">{shop.name}</span>
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/onboarding?new=1" />}>
          <Plus className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="text-sm">Add another shop</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
