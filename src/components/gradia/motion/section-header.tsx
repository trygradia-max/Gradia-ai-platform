import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Shared section heading rhythm — 11px uppercase eyebrow stacked
 * above a Geist 600 title and an optional subtitle. Used by dashboard
 * surfaces to inherit the same vertical rhythm without each one
 * re-rolling the typography. Hierarchy via weight + text color only
 * (redesign spec §8-A2); sizes come from the closed fixed scale.
 *
 * `title` and `subtitle` accept inline markup via React children so
 * callers can splice in a count without dangerouslySetInnerHTML.
 */
export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  align = "left",
  className,
}: {
  eyebrow: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  align?: "left" | "center"
  className?: string
}) {
  return (
    <div
      className={cn(
        "space-y-1.5",
        align === "center" && "text-center",
        className
      )}
    >
      <p className="label-eyebrow text-muted-foreground/80">{eyebrow}</p>
      <h2 className="font-display text-xl text-foreground">{title}</h2>
      {subtitle ? (
        <p
          className={cn(
            "max-w-prose text-sm text-muted-foreground",
            align === "center" && "mx-auto"
          )}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  )
}
