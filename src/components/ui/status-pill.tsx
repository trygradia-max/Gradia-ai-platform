import * as React from "react"

import { cn } from "@/lib/utils"

export type StatusPillTone =
  | "good"
  | "warn"
  | "bad"
  | "accent"
  | "muted"

const TONE_CLASS: Record<StatusPillTone, string> = {
  good:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warn:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad:
    "bg-destructive/15 text-destructive",
  /** Brand accent (racing orange) — fresh / new / call-to-attention. */
  accent:
    "bg-primary/12 text-primary",
  muted:
    "bg-muted text-muted-foreground",
}

export type StatusPillSize = "sm" | "default"

const SIZE_CLASS: Record<StatusPillSize, string> = {
  sm: "px-2 py-0.5 text-[10px]",
  default: "px-2.5 py-1 text-xs",
}

export type StatusPillProps = {
  tone?: StatusPillTone
  size?: StatusPillSize
  /** Optional leading icon — lucide-react component or anything that
   *  renders a small svg/element. */
  icon?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/**
 * One pill, every status surface. Replaces the four bespoke
 * "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide"
 * implementations that drifted across channel-connection-card,
 * agent-card, custom-agent-card, and ad-hoc spots in the editor /
 * mcp-tokens cards.
 *
 * Heat badge stays distinct because it carries scoring logic + a
 * tooltip; this primitive is for boolean-ish state ("Live", "Off",
 * "Needs info", "Paused").
 */
export function StatusPill({
  tone = "muted",
  size = "sm",
  icon,
  className,
  children,
}: StatusPillProps) {
  const isDefault = size === "default"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        SIZE_CLASS[size],
        // sm is uppercase/wide; default keeps natural case for badges
        // like "Connected" that read like normal labels.
        isDefault ? "tracking-normal" : "uppercase tracking-wide",
        TONE_CLASS[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
}
