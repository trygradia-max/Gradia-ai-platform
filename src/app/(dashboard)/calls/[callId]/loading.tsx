import { Skeleton } from "@/components/ui/skeleton"

/** Skeletons, never spinners, on page loads (spec §4). */
export default function CallRecordLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Skeleton className="h-4 w-32" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-20 w-full rounded-md" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-48 w-full rounded-md" />
      </div>
    </div>
  )
}
