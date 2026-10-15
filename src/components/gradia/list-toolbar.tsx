import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * Search, status, and local display controls for a list. Filters here must
 * change the server result, or be labelled as a local display option.
 */
export function ListToolbar({
  label,
  search,
  status,
  children,
  className,
}: {
  label: string
  search?: ReactNode
  status?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      role="search"
      aria-label={label}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      {search ? <div className="min-w-0 flex-1">{search}</div> : null}
      <div className="flex flex-wrap items-center gap-2">
        {status}
        {children}
      </div>
    </div>
  )
}
