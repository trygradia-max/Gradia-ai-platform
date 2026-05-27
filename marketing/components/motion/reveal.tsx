"use client"

import * as React from "react"
import { motion, useReducedMotion, type Variants } from "framer-motion"

import { cn } from "@/lib/utils"

export const EASE_OUT_EXPO: [number, number, number, number] = [
  0.22, 1, 0.36, 1,
]

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

type Tag = "div" | "section" | "article" | "ul" | "ol" | "header"

/**
 * Scroll-into-view stagger. Same language as the app's RevealOnScroll —
 * children that should participate are <RevealItem>. `once: true` so it
 * doesn't replay on every re-entry.
 */
export function RevealOnScroll({
  children,
  className,
  as = "div",
  amount = 0.15,
}: {
  children: React.ReactNode
  className?: string
  as?: Tag
  amount?: number
}) {
  const reduce = useReducedMotion()
  const MotionTag = motion[as] as typeof motion.div
  return (
    <MotionTag
      variants={reduce ? undefined : container}
      initial={reduce ? undefined : "hidden"}
      whileInView={reduce ? undefined : "show"}
      viewport={{ once: true, amount }}
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
    <motion.div variants={reduce ? undefined : item} className={cn(className)}>
      {children}
    </motion.div>
  )
}
