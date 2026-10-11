"use client"

import { useEffect } from "react"

/**
 * Moves focus to a landmark after an in-app route change. The App Router
 * does not manage focus on client navigation, so after Enter on a
 * conversation row focus fell back to <body> and a keyboard user had to
 * tab through the sidebar and top bar again (2026-10-09 keyboard pass).
 * The address of the first full page load is remembered so that load,
 * and its development double-effect, keep the browser's own start
 * position and the skip links in charge.
 */
let initialHref: string | null = null

export function RouteFocus({ targetId, routeKey }: { targetId: string; routeKey: string }) {
  useEffect(() => {
    const href = window.location.pathname + window.location.search
    if (initialHref === null) {
      initialHref = href
      return
    }
    if (href === initialHref) return
    initialHref = ""
    document.getElementById(targetId)?.focus()
  }, [targetId, routeKey])
  return null
}
