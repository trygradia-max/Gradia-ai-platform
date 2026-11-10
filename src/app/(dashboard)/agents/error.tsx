"use client"

import Link from "next/link"
import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"

import { ErrorState } from "@/components/gradia/error-state"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Unexpected failures in the agents segment only; expected read failures render their own states. */
export default function AgentsError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="mx-auto flex min-h-[40vh] max-w-xl items-center justify-center">
      <ErrorState
        title="Something went wrong with your agents"
        description="This was unexpected and nothing was changed. Try again, or go back to your agents."
        action={
          <>
            <Button type="button" className="min-h-11" onClick={() => unstable_retry()}>
              Try again
            </Button>
            <Link href="/agents" className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
              Back to agents
            </Link>
          </>
        }
      />
    </div>
  )
}
