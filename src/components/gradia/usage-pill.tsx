import Link from "next/link"

import { getUsageState } from "@/app/actions/billing"
import { cn } from "@/lib/utils"

/**
 * Topbar usage pill (spec §3 + §8-A7): human units in the headline —
 * "~200 texts · ~20 calls" — never bare credit numbers (those live in
 * fine print on the meters). Links to Numbers & Billing. Server
 * component; best-effort — renders nothing if usage can't load.
 */
export async function UsagePill() {
  let usage
  try {
    usage = await getUsageState()
  } catch (err) {
    console.error("[usage-pill] usage state failed:", err)
    return null
  }
  if (!usage) return null

  const warn = usage.credits.warn || usage.minutes.warn
  const parts = [`~${usage.human.texts} texts`]
  if (usage.voice && usage.human.calls !== null) {
    parts.push(`~${usage.human.calls} calls`)
  }

  return (
    <Link
      href="/billing"
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-3 py-1 font-data text-xs transition-colors duration-150 sm:inline-flex",
        warn
          ? "border-status-warning-fg/30 bg-status-warning-bg text-status-warning-fg"
          : "border-border/70 bg-card text-muted-foreground hover:border-border-strong hover:text-foreground"
      )}
    >
      {parts.join(" · ")}
    </Link>
  )
}
