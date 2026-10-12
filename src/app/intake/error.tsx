"use client"

import { ErrorState } from "@/components/gradia/error-state"
import { TeamChrome } from "@/components/gradia/team-chrome"

export default function IntakeError({ reset }: { reset: () => void }) {
  return (
    <TeamChrome>
      <ErrorState
        title="Intake review unavailable"
        description="Access or intake records could not be verified. Nothing was linked, dismissed, or sent."
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
