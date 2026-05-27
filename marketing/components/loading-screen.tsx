"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"

import { Logo } from "@/components/logo"

/**
 * First-visit loading curtain. Gated on sessionStorage so it only plays
 * once per session — repeat navigations never see it. Fades out after a
 * short beat; reduced-motion users skip it entirely.
 */
export function LoadingScreen() {
  const reduce = useReducedMotion()
  const [show, setShow] = React.useState(false)

  React.useEffect(() => {
    if (reduce) return
    if (sessionStorage.getItem("gradia_loaded")) return
    setShow(true)
    document.body.style.overflow = "hidden"
    const t = setTimeout(() => {
      sessionStorage.setItem("gradia_loaded", "1")
      setShow(false)
      document.body.style.overflow = ""
    }, 1500)
    return () => {
      clearTimeout(t)
      document.body.style.overflow = ""
    }
  }, [reduce])

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-background"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="mesh-hero pointer-events-none absolute inset-0" />
          <div className="grain-layer pointer-events-none absolute inset-0" />

          <motion.div
            className="relative flex flex-col items-center gap-6"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="relative flex size-16 items-center justify-center">
              <span className="absolute inset-0 rounded-full border border-border" />
              <span className="animate-spin-slow absolute inset-0 rounded-full border-2 border-transparent border-t-primary" />
              <Logo iconOnly className="size-7" />
            </div>
            <motion.p
              className="label-eyebrow text-muted-foreground/70"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              Opening the shop
            </motion.p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
