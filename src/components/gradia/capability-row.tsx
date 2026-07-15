"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronDown } from "lucide-react"

import { StatusPill } from "@/components/ui/status-pill"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * One row of "What Gradia does for you" (UX spec Part 2): a plain
 * owner-words capability with an on/off state, expanding to the existing
 * rich cards underneath. When nothing in the group is ready, the row
 * swaps its chevron for ONE owner-actionable button — never a
 * prerequisites panel.
 */
export function CapabilityRow({
  icon,
  title,
  blurb,
  on,
  detail,
  readyAction,
  defaultOpen = false,
  children,
}: {
  /** A rendered icon element — server pages can't pass component fns
   *  across the client boundary. */
  icon: React.ReactNode
  title: string
  blurb: string
  /** Is this capability doing work for the owner right now? */
  on: boolean
  /** Quiet status detail, e.g. "2 of 3 on". */
  detail?: string | null
  /** Shown instead of the expander when nothing here is set up yet. */
  readyAction?: { label: string; href: string } | null
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const hasChildren = React.Children.count(children) > 0
  const showAction = !on && readyAction
  // Configured-but-off groups get both: the one action AND the cards.
  const expandable = hasChildren

  return (
    <div className="rounded-md border border-border/60 bg-card/40">
      <div className="flex w-full items-center gap-3.5 px-4 py-4 sm:px-5">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
            on
              ? "bg-status-success-bg text-status-success-fg ring-status-success/25"
              : "bg-muted/60 text-muted-foreground ring-border/60"
          )}
        >
          {icon}
        </div>
        <button
          type="button"
          onClick={() => expandable && setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
          aria-expanded={open}
        >
          <span className="min-w-0">
            <span className="block truncate font-display text-lg tracking-tight text-foreground">
              {title}
            </span>
            <span className="block truncate text-sm text-muted-foreground">
              {blurb}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <StatusPill tone={on ? "good" : "muted"}>
              {on ? "On" : "Off"}
            </StatusPill>
            {detail ? (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {detail}
              </span>
            ) : null}
            {expandable ? (
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform duration-200",
                  open && "rotate-180"
                )}
                aria-hidden
              />
            ) : null}
          </span>
        </button>
        {showAction ? (
          <Link
            href={readyAction.href}
            className={cn(buttonVariants({ size: "sm" }), "shrink-0")}
          >
            {readyAction.label}
          </Link>
        ) : null}
      </div>
      {open && expandable ? (
        <div className="border-t border-border/40 px-4 pb-4 pt-4 sm:px-5">
          <div className="grid gap-4 md:grid-cols-2">{children}</div>
        </div>
      ) : null}
    </div>
  )
}
