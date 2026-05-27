"use client"

import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"

import { cn } from "@/lib/utils"

/**
 * Hover-lift card, ported from the app. Spring motion, subtle scale,
 * border reveal on hover. `glow` adds the accent ring for primary
 * surfaces.
 */
export function MotionCard({
  children,
  className,
  interactive = true,
  glow = false,
  ...rest
}: React.ComponentPropsWithoutRef<typeof motion.div> & {
  interactive?: boolean
  glow?: boolean
}) {
  const reduce = useReducedMotion()
  const hover =
    interactive && !reduce ? { y: -4, scale: 1.005 } : undefined
  return (
    <motion.div
      whileHover={hover}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      className={cn(
        "relative rounded-2xl border border-border/60 bg-card/70 backdrop-blur-sm",
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
