"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowRight,
  Bot,
  Calendar,
  Mail,
  MessageSquare,
  PhoneCall,
  StickyNote,
  User,
} from "lucide-react"

import { EmptyState } from "@/components/gradia/empty-state"
import { StatusPill } from "@/components/ui/status-pill"
import type { ActivityFeedItem } from "@/lib/data/activity"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

function relative(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

function itemIcon(item: ActivityFeedItem) {
  if (item.kind === "call") return PhoneCall
  if (item.kind === "agent_run") return Bot
  const t = item.title.toLowerCase()
  if (t.includes("email")) return Mail
  if (t.includes("book") || t.includes("resched") || t.includes("cancel"))
    return Calendar
  if (t.includes("note")) return StickyNote
  if (t.includes("lead")) return User
  return MessageSquare
}

type Filter = "all" | "handled"

/**
 * The glass box (spec §5.1): reverse-chron feed of what the agent did.
 * Routine wins log quietly; "Needs you" entries carry the amber pill and
 * link into Approvals. The "because" line renders ONLY where the
 * decision log has a row — never reconstructed. "Needs review" is a
 * door to /approvals, not a filter; "Escalated" is disabled until call
 * transfers exist to report.
 */
export function ActivityFeed({ items }: { items: ActivityFeedItem[] }) {
  const [filter, setFilter] = React.useState<Filter>("all")
  const s = STRINGS.pages.activity

  const visible =
    filter === "handled" ? items.filter((i) => i.outcome === "handled") : items

  const chipClass =
    "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150"

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/approvals"
          className={cn(
            chipClass,
            "border-status-warning-fg/30 bg-status-warning-bg text-status-warning-fg hover:border-status-warning-fg/50"
          )}
        >
          {s.filters.needsReview}
        </Link>
        {(["all", "handled"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              chipClass,
              "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              filter === f
                ? "border-border-strong bg-card text-foreground"
                : "border-border/60 text-muted-foreground hover:text-foreground"
            )}
          >
            {f === "all" ? s.filters.all : s.filters.handled}
          </button>
        ))}
        <span
          aria-disabled
          title={s.escalatedUnavailable}
          className={cn(chipClass, "cursor-not-allowed border-border/40 text-muted-foreground/50")}
        >
          {s.filters.escalated}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={STRINGS.chrome.nothingLoggedTitle}
          description={STRINGS.empty.activityFirstUse}
        />
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card">
          {visible.map((item) => {
            const Icon = itemIcon(item)
            return (
              <li key={item.id} className="flex items-start gap-3.5 px-4 py-3.5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-muted/60 text-muted-foreground">
                  <Icon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.title}
                    </p>
                    <p className="shrink-0 font-data text-xs text-muted-foreground">
                      {relative(item.at)}
                    </p>
                  </div>
                  {item.detail ? (
                    <p className="truncate text-sm text-muted-foreground">
                      {item.detail}
                    </p>
                  ) : null}
                  {/* The decision log line (spec §5.1) — data, not decoration. */}
                  {item.because ? (
                    <p className="border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
                      <span className="font-medium text-muted-foreground/80">
                        {s.whyLabel}:
                      </span>{" "}
                      {item.because}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2 pt-0.5">
                    <StatusPill
                      tone={
                        item.outcome === "needs-you"
                          ? "warn"
                          : item.outcome === "dropped"
                            ? "muted"
                            : "good"
                      }
                    >
                      {item.outcome === "needs-you"
                        ? s.outcome.needsYou
                        : item.outcome === "dropped"
                          ? s.outcome.dropped
                          : s.outcome.handled}
                    </StatusPill>
                    {item.href ? (
                      <Link
                        href={item.href}
                        className="inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline"
                      >
                        {item.kind === "call" ? s.viewCall : s.filters.needsReview}
                        <ArrowRight className="size-3" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
