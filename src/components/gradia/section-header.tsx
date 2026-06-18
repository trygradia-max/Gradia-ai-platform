import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The Gradia section signature: uppercase letter-spaced eyebrow, a serif
 * headline (pass the italic-accent word as <em> in `title`), and one quiet
 * subhead. Reuse on every major section — see BUILD_REFERENCE §1.
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
      <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
        {title}
      </h1>
      {subhead ? (
        <p className="max-w-prose text-sm text-muted-foreground">{subhead}</p>
      ) : null}
    </header>
  )
}
