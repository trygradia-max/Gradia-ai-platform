import { cn } from "@/lib/utils"

/** Film-grain overlay — drops onto the hero and dark sections. */
export function GrainOverlay({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "grain-layer pointer-events-none absolute inset-0 -z-10",
        className
      )}
    />
  )
}

/** Gradient-mesh anchor behind hero/feature sections. Parent must be relative. */
export function MeshBackground({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("mesh-hero pointer-events-none absolute inset-0 -z-10", className)}
    />
  )
}

/** Hairline gradient rule used between sections. */
export function RuleX({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("rule-x h-px w-full", className)}
    />
  )
}
