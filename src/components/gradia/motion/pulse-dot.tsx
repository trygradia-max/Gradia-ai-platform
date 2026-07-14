"use client"

import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"

import { cn } from "@/lib/utils"

const TONE_CLASS = {
  good: "bg-status-success-fg",
  accent: "bg-primary",
  muted: "bg-muted-foreground",
} as const

export type PulseDotTone = keyof typeof TONE_CLASS

/**
 * Animated status indicator — used for "AI is active," "live feed
 * online," "watching for inbound." Two-layer pulse: inner solid
 * disk + outer ring that breathes outward and fades.
 *
 * Pauses entirely under prefers-reduced-motion (a flashing dot is
 * the kind of motion that actually bothers people).
 */
export function PulseDot({
  tone = "accent",
  size = 8,
  className,
}: {
  tone?: PulseDotTone
  /** px diameter of the inner solid dot. */
  size?: number
  className?: string
}) {
  const reduce = useReducedMotion()
  const toneClass = TONE_CLASS[tone]
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {!reduce ? (
        <motion.span
          initial={{ scale: 1, opacity: 0.5 }}
          animate={{ scale: 2.4, opacity: 0 }}
          transition={{
            duration: 1.8,
            repeat: Infinity,
            ease: "easeOut",
          }}
          className={cn(
            "absolute inset-0 rounded-full",
            toneClass,
            "opacity-50"
          )}
        />
      ) : null}
      <span
        className={cn(
          "absolute inset-0 rounded-full",
          toneClass
        )}
      />
    </span>
  )
}
