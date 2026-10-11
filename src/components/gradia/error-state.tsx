import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * Same written shape as EmptyState, different job: what failed, then Retry
 * or a safe exit. Compact mode is the inline alert used on list/thread
 * failed loads. Page-level errors keep the centered card.
 */
export function ErrorState({
  title,
  description,
  action,
  compact = false,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
  className?: string
}) {
  if (compact) {
    return (
      <div
        role="alert"
        className={cn(
          "max-w-prose rounded-md bg-status-danger-bg px-4 py-3 text-sm text-status-danger-fg",
          className
        )}
      >
        <p>{title}</p>
        {description ? <p className="mt-1">{description}</p> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    )
  }

  return (
    <div
      role="alert"
      className={cn(
        "w-full max-w-md rounded-md border border-border bg-card px-6 py-12 text-center",
        className
      )}
    >
      <p className="font-display text-xl tracking-tight text-foreground">{title}</p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>
      ) : null}
    </div>
  )
}
