import * as React from "react"

import { cn } from "@/lib/utils"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

/**
 * Eyebrow + commanding display headline + optional sub. Used before
 * every section per the design spec — keeps section openers uniform.
 */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "left",
  className,
}: {
  eyebrow: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  align?: "left" | "center"
  className?: string
}) {
  return (
    <RevealOnScroll
      className={cn(
        "max-w-2xl space-y-3",
        align === "center" && "mx-auto text-center",
        className
      )}
    >
      <RevealItem>
        <p className="label-eyebrow flex items-center gap-2 text-muted-foreground/70">
          {align === "center" && (
            <span className="h-px w-6 bg-gradient-to-r from-transparent to-primary/50" />
          )}
          {eyebrow}
          {align === "center" && (
            <span className="h-px w-6 bg-gradient-to-l from-transparent to-primary/50" />
          )}
        </p>
      </RevealItem>
      <RevealItem>
        <h2 className="font-display text-[clamp(1.85rem,4.5vw,3rem)] leading-[1.04] tracking-[-0.025em] text-foreground">
          {title}
        </h2>
      </RevealItem>
      {subtitle && (
        <RevealItem>
          <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
            {subtitle}
          </p>
        </RevealItem>
      )}
    </RevealOnScroll>
  )
}
