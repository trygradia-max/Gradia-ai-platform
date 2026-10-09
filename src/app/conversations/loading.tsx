import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton rows, never spinners, on page loads (spec §4). */
export default function ConversationsLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden"
      role="status"
      aria-busy="true"
    >
      <p className="sr-only">Loading conversations</p>
      <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="space-y-3 border-border/70 p-4 lg:w-[24rem] lg:shrink-0 lg:border-r">
          <Skeleton className="h-3 w-24 max-w-full" />
          <Skeleton className="h-8 w-48 max-w-full" />
          <Skeleton className="h-4 w-full max-w-xs" />
          <div className="space-y-3 pt-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="space-y-3 rounded-md bg-card p-4 ring-1 ring-foreground/10"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-40 max-w-full" />
                    <Skeleton className="h-3 w-32 max-w-full" />
                  </div>
                  <Skeleton className="h-5 w-24 max-w-full rounded-full" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3 max-w-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="hidden min-w-0 flex-1 space-y-4 p-6 lg:block">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-24 w-full max-w-lg" />
        </div>
      </div>
    </div>
  )
}
