import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The Gradia section header: uppercase letter-spaced eyebrow, a Geist
 * 600 headline, and one quiet subhead. Hierarchy comes from weight and
 * text color, never a second typeface (redesign spec §8-A2 — the serif
 * signature is retired). `title` still accepts inline markup; <em> now
 * renders as plain emphasis, not a brand device.
 */
export function SectionHeader({
  eyebrow,
  title,
  subhead,
  className,
}: {
  eyebrow: string
  title: ReactNode
  subhead?: ReactNode
  className?: string
}) {
  return (
    <header className={cn("space-y-2", className)}>
      <p className="label-eyebrow text-muted-foreground/70">{eyebrow}</p>
      <h1 className="font-display text-2xl text-foreground">{title}</h1>
      {subhead ? (
        <p className="max-w-prose text-sm text-muted-foreground">{subhead}</p>
      ) : null}
    </header>
  )
}
