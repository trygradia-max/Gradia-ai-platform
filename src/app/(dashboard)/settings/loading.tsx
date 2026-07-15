import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton cards, never spinners, on page loads (spec §4). Settings loads
 *  ~15 data sources server-side; without this it was a blank screen on slow
 *  connections (2026-07-13 audit). */
export default function SettingsLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-10">
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border/60 p-5">
            <div className="flex items-center gap-3 pb-4">
              <Skeleton className="size-9 rounded-md" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}
