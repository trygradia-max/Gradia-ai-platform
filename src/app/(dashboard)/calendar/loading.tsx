import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton week grid, never spinners, on page loads (spec §4) — P0-010. */
export default function CalendarLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="rounded-md border border-border/60 p-4">
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-4 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-8 rounded-sm" />
            <Skeleton className="h-8 w-8 rounded-sm" />
          </div>
        </div>
        <div className="grid grid-cols-7 gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-28 w-full rounded-sm" />
              <Skeleton className="h-14 w-full rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
