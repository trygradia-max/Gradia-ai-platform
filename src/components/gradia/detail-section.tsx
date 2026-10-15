import type { ReactNode } from "react"

import { SectionHeader } from "@/components/gradia/section-header"
import { cn } from "@/lib/utils"

/**
 * A titled block on a record page: heading, optional help, body. Card
 * edges stay on the quiet divider token, not the louder control boundary.
 */
export function DetailSection({
  eyebrow,
  title,
  subhead,
  action,
  children,
  className,
}: {
  eyebrow: string
  title: ReactNode
  subhead?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <SectionHeader
        eyebrow={eyebrow}
        title={title}
        subhead={subhead}
        action={action}
      />
      <div className="rounded-md bg-card p-5 ring-1 ring-border sm:p-6">
        {children}
      </div>
    </section>
  )
}
