import { TeamChrome } from "@/components/gradia/team-chrome"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <TeamChrome className="space-y-4">
      <div aria-busy="true" className="space-y-4">
        <p role="status" className="text-sm text-muted-foreground">
          Loading intake review…
        </p>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-80 max-w-full" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-md p-5 ring-1 ring-border">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64 max-w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      </div>
    </TeamChrome>
  )
}
