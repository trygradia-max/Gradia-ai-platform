import { Skeleton } from "@/components/ui/skeleton"

/** Fail-closed builder loading state; the route may redirect while gated. */
export default function AgentBuilderLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-64 w-full rounded-md" />
    </div>
  )
}
