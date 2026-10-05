import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton rows, never spinners, on page loads (spec §4). */
export default function ConversationsLoading() {
  return (
    <main
      className="relative mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-6 sm:px-6 lg:max-w-4xl lg:py-8"
      role="status"
      aria-busy="true"
    >
      <p className="sr-only">Loading conversations</p>
      <div aria-hidden="true" className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24 max-w-full" />
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-11 w-28 max-w-full" />
          <Skeleton className="h-11 w-28 max-w-full" />
        </div>
        <div className="space-y-3">
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
    </main>
  )
}
