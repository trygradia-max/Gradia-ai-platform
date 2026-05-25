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
      ? { y: -4, scale: 1.005 }
      : undefined
  return (
    <motion.div
      whileHover={hover}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      className={cn(
        "relative rounded-2xl border border-border/60 bg-card",
        "transition-shadow duration-300",
        interactive && "hover:border-border",
        glow && "hover:accent-glow",
        className
      )}
      {...rest}
    >
      {children}
    </motion.div>
  )
}
