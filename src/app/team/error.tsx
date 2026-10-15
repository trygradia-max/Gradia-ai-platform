"use client"

import { ErrorState } from "@/components/gradia/error-state"
import { TeamChrome } from "@/components/gradia/team-chrome"

export default function TeamError({ reset }: { reset: () => void }) {
  return (
    <TeamChrome className="space-y-4">
      <ErrorState
        title="Team access unavailable"
        description="We could not verify your current access or load the records. No changes were made by this page."
        action={
          <button
            className="inline-flex min-h-11 items-center rounded-sm border border-border-control px-4 text-sm"
            onClick={reset}
          >
            Try again
          </button>
        }
      />
    </TeamChrome>
  )
}
