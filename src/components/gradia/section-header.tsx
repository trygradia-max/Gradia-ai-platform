import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * THE Gradia section header — the only one (2026-07-13 master audit: this
 * and motion/section-header.tsx had drifted into two APIs and two visual
 * rhythms; they are now unified here and the duplicate is deleted).
 *
 * Uppercase letter-spaced eyebrow, a Geist 600 headline, one quiet
 * subhead. Hierarchy comes from weight and text color, never a second
 * typeface or italic device (redesign spec §8-A2 — the serif signature is
 * retired). `title` accepts inline markup; <em> renders as plain emphasis.
 *
 * `level` picks the semantic heading + size from the closed scale:
 *   1 → <h1> text-2xl (page headers — one per page)
 *   2 → <h2> text-xl  (section headers — the common case, default)
 */
export function SectionHeader({
  eyebrow,
  title,
  subhead,
  level = 2,
  className,
}: {
  eyebrow: string
  title: ReactNode
  subhead?: ReactNode
  level?: 1 | 2
  className?: string
}) {
  const Heading = level === 1 ? "h1" : "h2"
  return (
    <header className={cn(level === 1 ? "space-y-2" : "space-y-1.5", className)}>
      <p className="label-eyebrow text-muted-foreground/70">{eyebrow}</p>
      <Heading
        className={cn(
          "font-display text-foreground",
          level === 1 ? "text-2xl" : "text-xl"
        )}
      >
        {title}
      </Heading>
      {subhead ? (
        <p className="max-w-prose text-sm text-muted-foreground">{subhead}</p>
      ) : null}
    </header>
  )
}
