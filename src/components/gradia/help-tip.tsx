"use client"

import { Info } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * The ⓘ next to a card or field title (reference board, Stripe pattern §3):
 * ≤ 2 narrator sentences on hover/focus. A composition of the existing
 * Tooltip primitive, not a new design component — the trigger is a real
 * button (keyboard-reachable, Escape closes) and carries an aria-label in
 * narrator voice so screen readers get the same sentence. Copy comes from
 * `STRINGS.help`; nothing is hardcoded here.
 */
export function HelpTip({
  text,
  label,
  className,
}: {
  /** The explanation shown in the tooltip. */
  text: string
  /** What the ⓘ is about, for the accessible name: "About Working hours". */
  label: string
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={`About ${label}`}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          className
        )}
      >
        <Info className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-[18rem] text-left leading-snug">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
