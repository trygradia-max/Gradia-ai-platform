"use client"

import { ErrorState } from "@/components/gradia/error-state"
import { SkipLink } from "@/components/gradia/skip-link"

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <>
      <SkipLink href="#main-content">Skip to error</SkipLink>
      <main id="main-content" tabIndex={-1} className="mx-auto flex min-h-screen max-w-3xl items-center justify-center p-6 outline-none">
        <ErrorState
          title="Policy drafts are unavailable"
          description="Access or draft data could not be verified. No policy was activated."
          action={
            <button
              className="inline-flex min-h-11 items-center rounded-sm border border-border-control px-4 text-sm"
              onClick={reset}
            >
              Try again
            </button>
          }
        />
      </main>
    </>
  )
}
