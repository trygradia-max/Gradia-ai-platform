import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * Evidence + status + one primary action region. Approvals keep their
 * existing decide handlers; this is chrome only.
 */
export function ReviewCard({
  eyebrow,
  title,
  status,
  evidence,
  actions,
  children,
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  status?: ReactNode
  evidence?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <article
      className={cn(
        "space-y-3 rounded-md bg-card p-5 ring-1 ring-border sm:p-6",
        className
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {eyebrow ? (
            <p className="label-eyebrow text-muted-foreground">{eyebrow}</p>
          ) : null}
          <div className="font-display text-lg text-foreground">{title}</div>
        </div>
        {status}
      </header>
      {evidence ? (
        <div className="space-y-2 text-sm text-muted-foreground">{evidence}</div>
      ) : null}
      {children}
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>
      ) : null}
    </article>
  )
}
