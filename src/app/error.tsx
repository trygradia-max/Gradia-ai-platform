"use client"

/**
 * Route-level error boundary — catches render/data errors from any page
 * below the root layout and shows a branded, honest fallback instead of
 * Next's unstyled crash screen (2026-07-13 master audit P1).
 *
 * Copy discipline: a real failure says it's a failure on our side — never
 * an invented excuse (glass-box principle).
 */

import { useEffect } from "react"
import Link from "next/link"
import * as Sentry from "@sentry/nextjs"

import { Button } from "@/components/ui/button"

export default function RouteError({
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
      <div className="w-full max-w-md rounded-md border border-border/60 bg-card/40 px-6 py-12 text-center">
        <p className="font-display text-xl tracking-tight text-foreground">
          That didn&apos;t load — the fault is on our side.
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
          Something failed while loading this page. Trying again usually
          fixes it; if it keeps happening, we&apos;re already looking at the
          error report.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Button type="button" onClick={() => reset()}>
            Try again
          </Button>
          <Button variant="outline" render={<Link href="/dashboard" />}>
            Back to Home
          </Button>
        </div>
      </div>
    </div>
  )
}
