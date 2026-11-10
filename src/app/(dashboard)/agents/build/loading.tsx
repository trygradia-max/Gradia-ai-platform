import { Skeleton } from "@/components/ui/skeleton"

/** Matches the builder layout: header, step rail (desktop) or compact progress (mobile), and the step panel. */
export default function AgentBuilderLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6" aria-busy="true" aria-label="Loading builder">
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <div className="hidden space-y-2 lg:block">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-11 w-full rounded-sm" />
          ))}
        </div>
        <div className="space-y-4">
          <Skeleton className="h-11 w-full rounded-sm lg:hidden" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-11 w-full rounded-sm" />
          <Skeleton className="h-28 w-full rounded-sm" />
          <Skeleton className="h-11 w-full rounded-sm" />
        </div>
      </div>
    </div>
  )
}
