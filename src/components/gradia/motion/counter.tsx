"use client"

import * as React from "react"
import {
  animate,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion"

/**
 * Count-up animator. Fires once when scrolled into view, respects
 * prefers-reduced-motion. Returns the formatted string via
 * children-as-renderer so callers can compose units / currency /
 * suffix without forking the component.
 *
 * Typical usage:
 *   <Counter to={revenue.cents / 100} duration={1.4}>
 *     {(v) => `$${v.toLocaleString()}`}
 *   </Counter>
 */
export function Counter({
  to,
  from = 0,
  duration = 1.6,
  decimals = 0,
  children,
}: {
  to: number
  from?: number
  duration?: number
  decimals?: number
  children?: (value: number) => React.ReactNode
}) {
  const reduce = useReducedMotion()
  const ref = React.useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: "-10% 0px" })
  const mv = useMotionValue(reduce ? to : from)
  const rounded = useTransform(mv, (v) =>
    decimals === 0 ? Math.round(v) : Number(v.toFixed(decimals))
  )
  const [display, setDisplay] = React.useState(reduce ? to : from)

  React.useEffect(() => {
    return rounded.on("change", (v) => setDisplay(v as number))
  }, [rounded])

  React.useEffect(() => {
    if (!inView || reduce) return
    const controls = animate(mv, to, {
      duration,
      ease: [0.22, 1, 0.36, 1],
    })
    return controls.stop
  }, [inView, mv, to, duration, reduce])

  return (
    <span ref={ref} className="tabular-nums">
      {children ? children(display) : display}
    </span>
  )
}
