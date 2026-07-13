import Link from "next/link"
import { CheckCircle2, CircleDashed } from "lucide-react"

import { getChannelProgressForCurrentShop } from "@/lib/data/channels"

/**
 * Header pill showing onboarding progress as "Setup 3/7 · Connect SMS".
 * Once every channel is live, swaps to a green "All channels live"
 * confirmation that fades on after the first full setup. Hides
 * entirely when there's no shop yet (pre-onboarding).
 */
export async function SetupProgressPill() {
  const progress = await getChannelProgressForCurrentShop()
  if (!progress) return null

  if (progress.connected === progress.total) {
    return (
      <Link
        href="/dashboard#channels"
        className="hidden items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-emerald-700 hover:bg-emerald-500/15 sm:flex dark:text-emerald-400"
      >
        <CheckCircle2 className="size-3" aria-hidden />
        All channels live
      </Link>
    )
  }

  return (
    <Link
      href={progress.nextHref ?? "/settings"}
      className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-medium tracking-wide text-foreground hover:bg-muted/70"
    >
      <CircleDashed
        className="size-3 text-muted-foreground"
        aria-hidden
      />
      <span className="uppercase tracking-widest text-muted-foreground">
        Setup
      </span>
      <span className="tabular-nums">
        {progress.connected}/{progress.total}
      </span>
      {progress.nextLabel ? (
        <span className="hidden text-muted-foreground md:inline">
          · Next: {progress.nextLabel}
        </span>
      ) : null}
    </Link>
  )
}
