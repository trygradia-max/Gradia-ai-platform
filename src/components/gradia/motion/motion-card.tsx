"use client"

import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"

import { cn } from "@/lib/utils"

/**
 * Hover-lift card. Spring-based motion, no scale crunch on tap so
 * touch users don't see a layout-shift jitter. Border + surface
 * comes from `card` token so the card feels native to the design
 * system rather than bolted-on.
 *
 * Renders as a div by default; pass `asChild` semantics via the
 * wrapping element instead — we deliberately don't ship a Slot
 * here because the hover transform needs a real DOM box to attach
 * to.
 */
export function MotionCard({
  children,
  className,
  interactive = true,
  glow = false,
  ...rest
}: React.ComponentPropsWithoutRef<typeof motion.div> & {
  interactive?: boolean
  /** Adds the accent-glow ring on hover for primary surfaces. */
  glow?: boolean
}) {
  const reduce = useReducedMotion()
  const hover =
    interactive && !reduce
      ? { y: -1 }
      : undefined
  return (
    <motion.div
      whileHover={hover}
      transition={{ duration: 0.12, ease: "easeOut" }}
      className={cn(
        // Cards sit on the 10px radius step (spec §2.5); elevation via
        // hairline border + border strengthen on hover, never glow —
        // the accent-glow treatment is public-pages-only (§8-A1).
        "relative rounded-md border border-border/60 bg-card",
        "transition-[border-color,box-shadow] duration-150",
        interactive && "hover:border-border-strong",
        glow && "hover:accent-glow",
        className
      )}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
