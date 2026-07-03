import Link from "next/link"

import { EmptyState } from "@/components/gradia/empty-state"
import { requireShop } from "@/lib/shop"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

/**
 * Activity — the glass box (redesign spec §5.1 / §8-A4). The route and
 * its chrome land in L2; the real feed (pending_actions +
 * custom_agent_runs + call records, with "because" lines only where the
 * decision log has data) is the L4-lite work. "Needs review" is a
 * deep-link to Approvals — it never duplicates that queue.
 */
export default async function ActivityPage() {
  await requireShop()
  const s = STRINGS.pages.activity

  const chipClass =
    "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150"

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">{s.eyebrow}</p>
        <h1 className="font-display text-2xl text-foreground">{s.title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {s.subtitle}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {/* Needs review lives in Approvals — this chip is a door, not a filter. */}
        <Link
          href="/approvals"
          className={cn(
            chipClass,
            "border-status-warning-fg/30 bg-status-warning-bg text-status-warning-fg hover:border-status-warning-fg/50"
          )}
        >
          {s.filters.needsReview}
        </Link>
        <span className={cn(chipClass, "border-border bg-card text-foreground")}>
          {s.filters.all}
        </span>
        <span className={cn(chipClass, "border-border/60 text-muted-foreground")}>
          {s.filters.handled}
        </span>
        <span className={cn(chipClass, "border-border/60 text-muted-foreground")}>
          {s.filters.escalated}
        </span>
      </div>

      <EmptyState
        title="Nothing logged yet."
        description={STRINGS.empty.activityFirstUse}
      />
    </div>
  )
}
