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
        "rounded-md bg-card px-6 py-12 text-center ring-1 ring-border",
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
