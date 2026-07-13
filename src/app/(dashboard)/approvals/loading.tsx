import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton cards, never spinners, on page loads (spec §4). */
export default function ApprovalsLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border/60 p-5 sm:p-6">
            <div className="flex items-start gap-3 pb-4">
              <Skeleton className="size-10 rounded-md" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-5 w-48" />
              </div>
            </div>
            <Skeleton className="ml-[52px] h-16 w-full max-w-lg rounded-md" />
            <div className="ml-[52px] mt-5 flex gap-2">
              <Skeleton className="h-10 w-24 rounded-sm" />
              <Skeleton className="h-10 w-24 rounded-sm" />
              <Skeleton className="h-10 w-24 rounded-sm" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
