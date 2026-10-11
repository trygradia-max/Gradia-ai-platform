"use client"

/**
 * Keeps the conversation shell in place when a list or thread page throws.
 * The root error boundary still covers failures above this layout.
 */

import { useEffect } from "react"
import Link from "next/link"
import * as Sentry from "@sentry/nextjs"

import { Button } from "@/components/ui/button"
import { STRINGS } from "@/lib/strings"

export default function ConversationsError({
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
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={() => reset()} className="min-h-11">
            {STRINGS.errors.dashboardRetry}
          </Button>
          <Button variant="outline" className="min-h-11" render={<Link href="/conversations" />}>
            Conversations
          </Button>
        </div>
      </div>
    </div>
  )
}
