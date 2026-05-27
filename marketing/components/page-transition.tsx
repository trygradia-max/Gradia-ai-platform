"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { motion, useReducedMotion } from "framer-motion"

/**
 * Route transition. Keyed on pathname so each navigation remounts and
 * replays a quick fade/rise. Kept short (0.4s) so it reads as polish,
 * not a delay. Reduced-motion users get content with no transform.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const reduce = useReducedMotion()

  if (reduce) return <>{children}</>

  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
