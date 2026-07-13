"use client"

import * as React from "react"
import { motion, useReducedMotion, type Variants } from "framer-motion"

import { cn } from "@/lib/utils"

/** Cinematic easing — PUBLIC PAGES ONLY (§8-A1). Dashboard feedback
 *  uses the functional defaults below (spec §2.5: 100–150ms). */
export const EASE_OUT_EXPO: [number, number, number, number] = [
  0.22, 1, 0.36, 1,
]

/** Functional feedback duration (spec §2.5) — the dashboard default. */
export const DURATION_FAST = 0.15

const container: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03 },
  },
}

const item: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION_FAST, ease: "easeOut" },
  },
}

const itemReduced: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2 } },
}

/**
 * Wraps a page section in a stagger reveal. Children that want to
 * participate must be <Stagger.Item>; everything else renders as-is.
 *
 * `as` lets the wrapper render any tag so consumers can wrap a
 * <section>, <main>, <div>, etc. without an extra DOM node.
 */
export function PageStagger({
  children,
  className,
  as = "div",
}: {
  children: React.ReactNode
  className?: string
  as?: "div" | "main" | "section" | "header" | "article"
}) {
  const reduce = useReducedMotion()
  const MotionTag = motion[as] as typeof motion.div
  return (
    <MotionTag
      variants={container}
      initial={reduce ? undefined : "hidden"}
      animate={reduce ? undefined : "show"}
      className={cn(className)}
    >
      {children}
    </MotionTag>
  )
}

export function StaggerItem({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode
  className?: string
  /** Override the parent's stagger delay for one item. */
  delay?: number
}) {
  const reduce = useReducedMotion()
  const variants = reduce ? itemReduced : item
  return (
    <motion.div
      variants={variants}
      transition={
        delay
          ? { delay, duration: DURATION_FAST, ease: "easeOut" }
          : undefined
      }
      className={cn(className)}
    >
      {children}
    </motion.div>
  )
}

PageStagger.Item = StaggerItem
