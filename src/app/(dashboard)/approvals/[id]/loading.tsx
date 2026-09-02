import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton, never a spinner, while one proposal loads (UX-001; state matrix). */
export default function ProposalLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Skeleton className="h-4 w-32" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="rounded-md border border-border/60 p-5 sm:p-6">
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-full rounded-sm" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-28 w-full rounded-sm" />
        </div>
        <div className="mt-5 flex gap-2">
          <Skeleton className="h-10 w-28 rounded-sm" />
          <Skeleton className="h-10 w-24 rounded-sm" />
        </div>
      </div>
    </div>
  )
}
