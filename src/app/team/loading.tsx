import { TeamChrome } from "@/components/gradia/team-chrome"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <TeamChrome className="space-y-8">
      <p role="status" className="sr-only">
        Loading your team and permitted work…
      </p>
      <div className="space-y-3" aria-hidden>
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <div className="space-y-3" aria-hidden>
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    </TeamChrome>
  )
}
