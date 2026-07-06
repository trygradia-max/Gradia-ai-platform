import { Skeleton } from "@/components/ui/skeleton"

/** Skeletons, never spinners, on page loads (spec §4). */
export default function HomeLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-12">
      <div className="rounded-md border border-border/60 px-6 py-6 sm:px-8 sm:py-7">
        <div className="space-y-4">
          <Skeleton className="h-3 w-52" />
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-28 w-full rounded-md" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="space-y-2 rounded-md border border-border/60 px-4 py-3.5"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-40 w-full rounded-md" />
      </div>
    </div>
  )
}
