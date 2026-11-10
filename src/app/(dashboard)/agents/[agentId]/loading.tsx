import { Skeleton } from "@/components/ui/skeleton"

export default function AgentDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8" aria-busy="true" aria-label="Loading agent">
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-5 w-48 max-w-full" />
      </div>
      <Skeleton className="h-14 w-full rounded-md" />
      <Skeleton className="h-64 w-full rounded-md" />
      <Skeleton className="h-40 w-full rounded-md" />
    </div>
  )
}
