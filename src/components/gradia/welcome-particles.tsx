"use client"

import * as React from "react"
import { useReducedMotion } from "framer-motion"

type Particle = {
  x: number
  y: number
  r: number
  vx: number
  vy: number
  color: string
  alpha: number
}

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value || fallback
}

/**
 * Soft silver/violet drift for the post-setup welcome. Canvas only —
 * paused entirely under prefers-reduced-motion. Pointer-events none.
 */
export function WelcomeParticles() {
  const reduce = useReducedMotion()
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    if (reduce) return
    const surface = canvasRef.current
    if (!surface) return
    const raw = surface.getContext("2d")
    if (!raw) return
    const paint: CanvasRenderingContext2D = raw
    const canvas = surface

    const silver = readToken("--text-secondary", "#a5adba")
    const violet = readToken("--accent-text", "#a78bfa")
    let particles: Particle[] = []
    let frame = 0
    let running = true

    function resize() {
      const { clientWidth, clientHeight } = canvas
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(clientWidth * dpr))
      canvas.height = Math.max(1, Math.floor(clientHeight * dpr))
      paint.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed(clientWidth, clientHeight)
    }

    function seed(width: number, height: number) {
      const count = Math.min(64, Math.max(28, Math.round((width * height) / 28000)))
      particles = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.6 + Math.random() * 1.6,
        vx: (Math.random() - 0.5) * 0.18,
        vy: -0.04 - Math.random() * 0.12,
        color: i % 3 === 0 ? violet : silver,
        alpha: 0.12 + Math.random() * 0.28,
      }))
    }

    function tick() {
      if (!running) return
      const { clientWidth: width, clientHeight: height } = canvas
      paint.clearRect(0, 0, width, height)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.y < -4) p.y = height + 4
        if (p.x < -4) p.x = width + 4
        if (p.x > width + 4) p.x = -4
        paint.beginPath()
        paint.fillStyle = p.color
        paint.globalAlpha = p.alpha
        paint.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        paint.fill()
      }
      paint.globalAlpha = 1
      frame = window.requestAnimationFrame(tick)
    }

    const onVis = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frame)
      } else if (running) {
        frame = window.requestAnimationFrame(tick)
      }
    }

    resize()
    frame = window.requestAnimationFrame(tick)
    window.addEventListener("resize", resize)
    document.addEventListener("visibilitychange", onVis)
    return () => {
      running = false
      window.cancelAnimationFrame(frame)
      window.removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [reduce])

  if (reduce) return null

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}
