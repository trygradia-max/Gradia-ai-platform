import { Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"

/** Gradia wordmark — accent tile + serif word. Matches the app's nav badge. */
export function Logo({
  iconOnly = false,
  className,
}: {
  iconOnly?: boolean
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="flex size-6 items-center justify-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/25">
        <Sparkles className="size-3" aria-hidden />
      </span>
      {!iconOnly && (
        <span className="font-display text-lg tracking-tight text-foreground">
          Gradia
        </span>
      )}
    </span>
  )
}
