import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Shared section heading rhythm — 11px uppercase eyebrow stacked
 * above a serif-display title and an optional subtitle. Used by
 * dashboard surfaces to inherit the same vertical rhythm as the
 * hero without each one re-rolling the typography.
 *
 * `title` and `subtitle` accept inline markup via React children
 * so callers can italicize a phrase or splice in a count without
 * the dangerouslySetInnerHTML escape hatch.
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
      <h2 className="font-display text-2xl text-foreground sm:text-3xl">
        {title}
      </h2>
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
