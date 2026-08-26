"use client"

/**
 * Dashboard-level error boundary (P0-010) — catches render/data errors from
 * any dashboard page while KEEPING the sidebar shell, so the owner recovers
 * in place instead of losing the whole app frame (the root error.tsx handles
 * failures above this layout). Reports to Sentry like every boundary.
 */

import { useEffect } from "react"
import Link from "next/link"
import * as Sentry from "@sentry/nextjs"

import { Button } from "@/components/ui/button"
import { STRINGS } from "@/lib/strings"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-md border border-border/60 bg-card/40 px-6 py-12 text-center"
      >
        <p className="font-display text-xl tracking-tight text-foreground">
          {STRINGS.errors.dashboardTitle}
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          {STRINGS.errors.dashboardBody}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Button type="button" onClick={() => reset()}>
            {STRINGS.errors.dashboardRetry}
          </Button>
          <Button variant="outline" render={<Link href="/dashboard" />}>
            {STRINGS.errors.dashboardHome}
          </Button>
        </div>
      </div>
    </div>
  )
}
