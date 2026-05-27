"use client"

import * as React from "react"
import Lenis from "lenis"

/**
 * Global Lenis smooth scroll. Exposes the instance on `window.__lenis`
 * so the nav can do offset anchor scrolling through it. Respects
 * reduced-motion by skipping init entirely (native scroll takes over).
 */
declare global {
  interface Window {
    __lenis?: Lenis
  }
}

export function SmoothScroll({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    if (prefersReduced) return

    const lenis = new Lenis({
      duration: 1.1,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    })
    window.__lenis = lenis

    let raf = 0
    const loop = (time: number) => {
      lenis.raf(time)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      lenis.destroy()
      window.__lenis = undefined
    }
  }, [])

  return <>{children}</>
}

/** Smoothly scroll to a #hash target through Lenis, with nav offset. */
export function scrollToHash(hash: string) {
  const id = hash.replace(/^#/, "")
  const el = document.getElementById(id)
  if (!el) return
  if (window.__lenis) {
    window.__lenis.scrollTo(el, { offset: -88, duration: 1.1 })
  } else {
    el.scrollIntoView({ behavior: "smooth" })
  }
}
