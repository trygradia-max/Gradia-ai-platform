import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton, never a spinner, while the Starting point loads. */
export default function StartingPointLoading() {
  return (
    <div role="status" aria-busy="true" className="mx-auto w-full max-w-4xl space-y-8">
      <span className="sr-only">Loading your starting point</span>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}
