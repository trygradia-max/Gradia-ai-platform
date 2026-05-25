"use client"

import * as React from "react"
import { motion, useReducedMotion, type Variants } from "framer-motion"

import { cn } from "@/lib/utils"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"

const container: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.08 },
  },
}

const item: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: EASE_OUT_EXPO },
  },
}

/**
 * Same stagger language as PageStagger, but fires on scroll-into-view
 * instead of on mount. Used on long marketing pages where sections
 * sit far below the fold and shouldn't animate before the operator
 * has scrolled to them.
 *
 * `once: true` so re-entering the viewport doesn't replay — feels
 * cheap on subsequent scrolls.
 */
export function RevealOnScroll({
  children,
  className,
  as = "div",
}: {
  children: React.ReactNode
  className?: string
  as?: "div" | "section" | "article" | "ul" | "ol"
}) {
  const reduce = useReducedMotion()
  const MotionTag = motion[as] as typeof motion.div

  return (
    <MotionTag
      variants={reduce ? undefined : container}
      initial={reduce ? undefined : "hidden"}
      whileInView={reduce ? undefined : "show"}
      viewport={{ once: true, amount: 0.15 }}
      className={cn(className)}
    >
      {children}
    </MotionTag>
  )
}

export function RevealItem({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      variants={reduce ? undefined : item}
      className={cn(className)}
    >
      {children}
    </motion.div>
  )
}
