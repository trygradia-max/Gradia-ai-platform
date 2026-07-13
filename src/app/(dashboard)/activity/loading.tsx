import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton rows, never spinners, on page loads (spec §4). */
export default function ActivityLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-80 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-20 rounded-full" />
        ))}
      </div>
      <div className="divide-y divide-border/60 rounded-md border border-border/60">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3.5 px-4 py-3.5">
            <Skeleton className="size-9 rounded-sm" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-full max-w-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
