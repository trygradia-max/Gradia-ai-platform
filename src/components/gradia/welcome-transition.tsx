"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"

import { Button } from "@/components/ui/button"
import { WelcomeParticles } from "@/components/gradia/welcome-particles"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { STRINGS } from "@/lib/strings"
import { welcomeHeading } from "@/lib/welcome"

/**
 * Full-viewport welcome after setup. Continue is available immediately —
 * no timer, spinner, or progress bar. Reduced motion drops particles and
 * the slide, and keeps a static charcoal screen.
 */
export function WelcomeTransition({ shopName }: { shopName: string }) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(true)
  const heading = welcomeHeading(shopName)
  const copy = STRINGS.pages.welcome

  const dismiss = React.useCallback(() => {
    if (!open) return
    setOpen(false)
  }, [open])

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        dismiss()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [dismiss])

  function handleExitComplete() {
    router.replace("/dashboard", { scroll: false })
  }

  return (
    <AnimatePresence onExitComplete={handleExitComplete}>
      {open ? (
        <motion.div
          key="welcome"
          role="dialog"
          aria-modal="true"
          aria-labelledby="welcome-heading"
          aria-describedby="welcome-hint"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0.2 : 0.4, ease: EASE_OUT_EXPO }}
          className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-background px-6"
        >
          <WelcomeParticles />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_oklab,var(--accent)_14%,transparent),transparent_58%)]"
          />
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
            className="relative z-10 flex max-w-xl flex-col items-center gap-6 text-center"
          >
            <h1
              id="welcome-heading"
              className="font-display text-[clamp(1.75rem,5vw,2.75rem)] leading-[1.08] tracking-[-0.03em] text-foreground"
            >
              {heading}
            </h1>
            <p id="welcome-hint" className="text-sm text-muted-foreground">
              {copy.hint}
            </p>
            <Button
              type="button"
              autoFocus
              onClick={dismiss}
              className="min-h-11 px-5"
            >
              {copy.continue}
            </Button>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
