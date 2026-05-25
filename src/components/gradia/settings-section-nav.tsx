"use client"

import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"

import { cn } from "@/lib/utils"

export type SettingsSection = {
  /** DOM id of the section's outer wrapper — also the URL hash. */
  id: string
  label: string
}

/**
 * Sticky horizontal nav for the long single-page Settings layout.
 *
 * Built on the same shared-element pattern as the sidebar: the active
 * tab renders a `motion.span` with a shared `layoutId`, so when the
 * active section changes (either via click or scroll), the 2px accent
 * underline physically slides between tabs.
 *
 * Active state is driven by an IntersectionObserver — whatever section
 * has the largest visible area in the upper half of the viewport wins.
 * Clicks scroll to the target section and update the URL hash so the
 * page stays deep-linkable.
 */
export function SettingsSectionNav({
  sections,
}: {
  sections: SettingsSection[]
}) {
  const reduce = useReducedMotion()
  const [activeId, setActiveId] = React.useState<string>(sections[0]?.id ?? "")
  const observerRef = React.useRef<IntersectionObserver | null>(null)

  // Track which section is in view as the operator scrolls.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (sections.length === 0) return

    const visibility = new Map<string, number>()

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibility.set(entry.target.id, entry.intersectionRatio)
        }
        // Pick the section with the highest visibility ratio.
        let topId = sections[0]?.id ?? ""
        let topRatio = -1
        for (const [id, ratio] of visibility) {
          if (ratio > topRatio) {
            topRatio = ratio
            topId = id
          }
        }
        if (topRatio > 0) setActiveId(topId)
      },
      {
        // Trigger when section is in the top ~60% of viewport, with a
        // bit of headroom for the sticky nav itself.
        rootMargin: "-80px 0px -40% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    )

    for (const { id } of sections) {
      const el = document.getElementById(id)
      if (el) observerRef.current.observe(el)
    }

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [sections])

  // No explicit hash-sync effect: the browser handles the initial
  // `#section` jump natively (via the section ids), and the
  // IntersectionObserver above picks up the resulting visible section
  // and sets active state from there. That keeps SSR + first paint
  // agreeing and avoids a setState-in-effect lint flag.

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    e.preventDefault()
    const el = document.getElementById(id)
    if (!el) return
    setActiveId(id)
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
    if (typeof window !== "undefined") {
      // Update hash without a second scroll jump.
      window.history.replaceState(null, "", `#${id}`)
    }
  }

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-0 z-30 -mx-4 border-b border-border/40 bg-background/80 px-4 backdrop-blur-md supports-backdrop-filter:bg-background/60 sm:-mx-6 sm:px-6"
    >
      <div className="-mb-px flex gap-1 overflow-x-auto pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sections.map((s) => {
          const isActive = s.id === activeId
          return (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => handleClick(e, s.id)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "relative shrink-0 px-3 py-2.5 text-sm font-medium transition-colors duration-200",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {s.label}
              {isActive ? (
                <motion.span
                  layoutId="settings-nav-active-underline"
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 380, damping: 32 }
                  }
                  className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-primary"
                  aria-hidden
                />
              ) : null}
            </a>
          )
        })}
      </div>
    </nav>
  )
}
