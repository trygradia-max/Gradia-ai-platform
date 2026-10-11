import type { ReactNode } from "react"
import Link from "next/link"

import { cn } from "@/lib/utils"

const pageLink =
  "inline-flex min-h-11 items-center rounded-sm text-sm text-accent-text underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"

/**
 * Previous / Next for a named collection. Does not invent a total. Disabled
 * ends are omitted rather than faked as page-number theater.
 */
export function Pagination({
  label,
  status,
  previous,
  next,
  className,
}: {
  label: string
  status?: ReactNode
  previous?: { href: string; label?: string } | null
  next?: { href: string; label?: string } | null
  className?: string
}) {
  return (
    <nav
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}
    >
      {status ? (
        <p className="text-sm text-muted-foreground">{status}</p>
      ) : null}
      {previous ? (
        <Link className={pageLink} href={previous.href}>
          {previous.label ?? "Previous"}
        </Link>
      ) : null}
      {next ? (
        <Link className={pageLink} href={next.href}>
          {next.label ?? "Next"}
        </Link>
      ) : null}
    </nav>
  )
}
