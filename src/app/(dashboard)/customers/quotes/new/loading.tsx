import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton, never a spinner, while the quote builder loads (UX-001; state matrix). */
export default function NewQuoteLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="space-y-4 rounded-md border border-border/60 p-5">
        <Skeleton className="h-10 w-full rounded-sm" />
        <Skeleton className="h-10 w-full rounded-sm" />
        <div className="space-y-2 pt-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-sm" />
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Skeleton className="h-10 w-28 rounded-sm" />
        </div>
      </div>
    </div>
  )
}
