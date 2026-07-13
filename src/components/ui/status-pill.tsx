import * as React from "react"

import { cn } from "@/lib/utils"

export type StatusPillTone =
  | "good"
  | "warn"
  | "bad"
  | "accent"
  | "muted"

/* Semantic status tokens only (spec §2.3) — these colors carry meaning
 * and appear nowhere else. `accent` = the one brand purple, for
 * fresh/new/AI-in-progress; text uses the AA-safe accent-text variant. */
const TONE_CLASS: Record<StatusPillTone, string> = {
  good: "bg-status-success-bg text-status-success-fg",
  warn: "bg-status-warning-bg text-status-warning-fg",
  bad: "bg-status-danger-bg text-status-danger-fg",
  accent: "bg-status-info-bg text-status-info-fg",
  muted: "bg-muted text-muted-foreground",
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
