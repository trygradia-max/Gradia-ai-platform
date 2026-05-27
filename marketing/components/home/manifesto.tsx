"use client"

import * as React from "react"
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion"

import { GrainOverlay } from "@/components/textures"

/**
 * Full-bleed manifesto. The wide studio shot parallaxes behind an
 * oversized pull-quote that bleeds past the content column — the
 * grid-breaking, asymmetric moment that gives the page tension.
 */
export function Manifesto() {
  const reduce = useReducedMotion()
  const ref = React.useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  })
  const y = useTransform(scrollYProgress, [0, 1], ["-8%", "8%"])
  const scale = useTransform(scrollYProgress, [0, 1], [1.08, 1.18])

  return (
    <section
      ref={ref}
      className="relative isolate my-12 overflow-hidden"
    >
      {/* Parallax background */}
      <motion.div
        aria-hidden
        style={reduce ? undefined : { y, scale }}
        className="absolute inset-0 -z-20"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/assets/images/manifesto.jpg"
          alt=""
          className="size-full object-cover"
        />
      </motion.div>
      {/* Scrims for legibility */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-background via-background/80 to-background/30" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-background via-transparent to-background/70" />
      <GrainOverlay />

      <div className="mx-auto max-w-6xl px-5 py-32 sm:px-8 sm:py-44">
        {/* Numeral bleeds up-left, headline bleeds left of the column */}
        <span
          aria-hidden
          className="section-numeral block"
        >
          —
        </span>
        <motion.blockquote
          initial={reduce ? undefined : { opacity: 0, y: 30 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="-mt-4 max-w-4xl font-display text-[clamp(2.25rem,6.5vw,5rem)] leading-[1.0] tracking-[-0.035em] text-foreground sm:-ml-2"
        >
          We draft.{" "}
          <span className="italic text-primary">You decide.</span> The lead
          never waits, and the wrong word never ships.
        </motion.blockquote>
        <motion.p
          initial={reduce ? undefined : { opacity: 0 }}
          whileInView={reduce ? undefined : { opacity: 1 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ delay: 0.2, duration: 0.6 }}
          className="mt-7 max-w-md text-base leading-relaxed text-muted-foreground"
        >
          That&apos;s the entire philosophy. Speed where it&apos;s safe, your
          judgment where it counts — across every call, text, email, and DM.
        </motion.p>
      </div>
    </section>
  )
}
