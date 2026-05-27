"use client"

import { motion, useReducedMotion } from "framer-motion"

import { GrainOverlay } from "@/components/textures"

/**
 * Full-bleed video flex — pure visual punch. The foam clip runs behind
 * a single oversized command line. Reduced-motion / slow-net users get
 * the poster still and never load the clip.
 */
export function ShowReel() {
  const reduce = useReducedMotion()
  return (
    <section className="relative isolate flex min-h-[70vh] items-center overflow-hidden sm:min-h-[80vh]">
      <div className="absolute inset-0 -z-20">
        {!reduce ? (
          <video
            className="size-full object-cover"
            autoPlay
            muted
            loop
            playsInline
            poster="/assets/images/feature-detail.jpg"
          >
            <source src="/assets/videos/showreel.mp4" type="video/mp4" />
          </video>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/assets/images/feature-detail.jpg"
            alt=""
            className="size-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/55 to-background/20" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/50" />
      </div>
      <GrainOverlay />

      <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        <motion.p
          initial={reduce ? undefined : { opacity: 0, y: 16 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="label-eyebrow text-primary"
        >
          While you work the paint
        </motion.p>
        <motion.h2
          initial={reduce ? undefined : { opacity: 0, y: 28 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
          className="mt-4 max-w-4xl font-display text-[clamp(2.5rem,8vw,6rem)] leading-[0.98] tracking-[-0.035em] text-foreground"
        >
          We&apos;re working the{" "}
          <span className="italic text-primary">phone</span>.
        </motion.h2>
        <motion.p
          initial={reduce ? undefined : { opacity: 0 }}
          whileInView={reduce ? undefined : { opacity: 1 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ delay: 0.25, duration: 0.6 }}
          className="mt-6 max-w-md text-base leading-relaxed text-foreground/80 sm:text-lg"
        >
          The buffer doesn&apos;t stop for a ringing phone anymore. Neither does
          the booking, the quote, or the follow-up.
        </motion.p>
      </div>
    </section>
  )
}
