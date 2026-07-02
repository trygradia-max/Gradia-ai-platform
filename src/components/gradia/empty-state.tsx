import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A written empty state — never a blank panel (BUILD_REFERENCE §1). Title in
 * the display voice, one plain sentence, and an optional single action.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/60 bg-card/40 px-6 py-12 text-center",
        className
      )}
    >
      <p className="font-display text-xl tracking-tight text-foreground">
        {title}
      </p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}
