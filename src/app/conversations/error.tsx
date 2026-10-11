"use client"

/**
 * Keeps the conversation shell in place when a list or thread page throws.
 * The root error boundary still covers failures above this layout.
 */

import { useEffect } from "react"
import Link from "next/link"
import * as Sentry from "@sentry/nextjs"

import { ErrorState } from "@/components/gradia/error-state"
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
      <ErrorState
        title={STRINGS.errors.dashboardTitle}
        description={STRINGS.errors.dashboardBody}
        action={
          <>
            <Button type="button" onClick={() => reset()} className="min-h-11">
              {STRINGS.errors.dashboardRetry}
            </Button>
            <Button variant="outline" className="min-h-11" render={<Link href="/conversations" />}>
              Conversations
            </Button>
          </>
        }
      />
    </div>
  )
}
