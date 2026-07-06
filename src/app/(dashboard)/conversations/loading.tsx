import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton rows, never spinners, on page loads (spec §4). */
export default function ConversationsLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-16" />
        <div className="divide-y divide-border/60 rounded-md border border-border/60">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3.5 px-4 py-3.5">
              <Skeleton className="size-9 rounded-sm" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-full max-w-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
