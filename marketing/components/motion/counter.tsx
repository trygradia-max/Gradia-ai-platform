"use client"

import * as React from "react"
import {
  animate,
  useInView,
  useReducedMotion,
} from "framer-motion"

import { EASE_OUT_EXPO } from "@/components/motion/reveal"

/**
 * Counts up from 0 to `value` the first time it scrolls into view.
 * Reduced-motion users jump straight to the final number.
 */
export function Counter({
  value,
  prefix = "",
  suffix = "",
  duration = 1.4,
  className,
}: {
  value: number
  prefix?: string
  suffix?: string
  duration?: number
  className?: string
}) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.6 })
  const reduce = useReducedMotion()
  const [display, setDisplay] = React.useState(reduce ? value : 0)

  React.useEffect(() => {
    if (!inView || reduce) return
    const controls = animate(0, value, {
      duration,
      ease: EASE_OUT_EXPO,
      onUpdate: (v) => setDisplay(Math.round(v)),
    })
    return () => controls.stop()
  }, [inView, value, duration, reduce])

  return (
    <span ref={ref} className={className}>
      {prefix}
      {display}
      {suffix}
    </span>
  )
}
