import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton, never a spinner, while the agent builder loads (UX-001; state
 *  matrix). The route is flag-gated (`FEATURES.workflowBuilder`) — when the
 *  flag is off the page redirects and this never shows. */
export default function AgentBuildLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-16 rounded-sm" />
      </div>
      <div className="space-y-4 rounded-md border border-border/60 p-5">
        <Skeleton className="h-24 w-full rounded-sm" />
        <div className="flex justify-end">
          <Skeleton className="h-10 w-32 rounded-sm" />
        </div>
      </div>
    </div>
  )
}
