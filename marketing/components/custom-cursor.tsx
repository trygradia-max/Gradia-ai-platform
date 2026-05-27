"use client"

import * as React from "react"
import { motion, useMotionValue, useSpring } from "framer-motion"

/**
 * Reactive cursor. A small accent dot tracks the pointer 1:1; a larger
 * ring trails on a spring and swells + brightens when hovering anything
 * marked data-cursor="cta" (CTAs, links, cards). Only mounts on devices
 * with a fine pointer — touch keeps the native cursor.
 */
export function CustomCursor() {
  const [enabled, setEnabled] = React.useState(false)
  const [hovering, setHovering] = React.useState(false)

  const x = useMotionValue(-100)
  const y = useMotionValue(-100)
  const ringX = useSpring(x, { stiffness: 380, damping: 30, mass: 0.5 })
  const ringY = useSpring(y, { stiffness: 380, damping: 30, mass: 0.5 })

  React.useEffect(() => {
    const fine =
      window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!fine) return

    setEnabled(true)
    document.documentElement.classList.add("has-custom-cursor")

    const move = (e: PointerEvent) => {
      x.set(e.clientX)
      y.set(e.clientY)
      const target = e.target as HTMLElement | null
      setHovering(Boolean(target?.closest('[data-cursor="cta"]')))
    }
    window.addEventListener("pointermove", move)
    return () => {
      window.removeEventListener("pointermove", move)
      document.documentElement.classList.remove("has-custom-cursor")
    }
  }, [x, y])

  if (!enabled) return null

  return (
    <>
      <motion.div
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[100] size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
        style={{ x, y }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/60"
        style={{ x: ringX, y: ringY }}
        animate={{
          width: hovering ? 56 : 30,
          height: hovering ? 56 : 30,
          opacity: hovering ? 1 : 0.5,
          backgroundColor: hovering
            ? "color-mix(in oklab, var(--primary) 12%, transparent)"
            : "rgba(0,0,0,0)",
        }}
        transition={{ type: "spring", stiffness: 300, damping: 24 }}
      />
    </>
  )
}
