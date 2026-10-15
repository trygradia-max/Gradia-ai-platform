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

import { ErrorState } from "@/components/gradia/error-state"
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
      <ErrorState
        title={STRINGS.errors.dashboardTitle}
        description={STRINGS.errors.dashboardBody}
        action={
          <>
            <Button type="button" className="min-h-11" onClick={() => reset()}>
              {STRINGS.errors.dashboardRetry}
            </Button>
            <Button variant="outline" className="min-h-11" render={<Link href="/dashboard" />}>
              {STRINGS.errors.dashboardHome}
            </Button>
          </>
        }
      />
    </div>
  )
}
