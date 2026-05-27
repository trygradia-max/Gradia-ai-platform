"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRight, ChevronDown, Sparkles } from "lucide-react"
import { motion, useReducedMotion, type Variants } from "framer-motion"

import { SITE } from "@/lib/site"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { GrainOverlay, MeshBackground } from "@/components/textures"
import { scrollToHash } from "@/components/smooth-scroll"

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]

/** Entrance sequence — each child enters ~100ms after the previous. */
const parent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1, delayChildren: 0.15 } },
}
const child: Variants = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
}

export function Hero() {
  const reduce = useReducedMotion()

  return (
    <section className="relative isolate flex min-h-screen items-center overflow-hidden px-5 pt-28 pb-20 sm:px-8">
      {/* Cinematic video background — poster carries the look until the
       *  clip loads, and stands in entirely on reduced-motion / slow nets. */}
      <div className="absolute inset-0 -z-20">
        {!reduce && (
          <video
            className="size-full object-cover"
            autoPlay
            muted
            loop
            playsInline
            poster="/assets/images/hero-car.jpg"
          >
            <source src="/assets/videos/hero.mp4" type="video/mp4" />
          </video>
        )}
        {reduce && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/assets/images/hero-car.jpg"
            alt=""
            className="size-full object-cover"
          />
        )}
        {/* Legibility scrims — darken left + bottom where copy sits. */}
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/60" />
        {/* Edge vignette pulls focus inward. */}
        <div className="vignette absolute inset-0" />
      </div>
      <MeshBackground />
      <GrainOverlay />

      <motion.div
        className="mx-auto flex w-full max-w-6xl flex-col items-start gap-7"
        variants={reduce ? undefined : parent}
        initial={reduce ? undefined : "hidden"}
        animate={reduce ? undefined : "show"}
      >
        <motion.div variants={reduce ? undefined : child}>
          <span className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-card/50 px-3 py-1.5 backdrop-blur-md">
            <span className="flex size-4 items-center justify-center rounded bg-primary/15 text-primary ring-1 ring-primary/25">
              <Sparkles className="size-2.5" aria-hidden />
            </span>
            <span className="label-eyebrow !text-foreground/80">
              For working detail shops
            </span>
          </span>
        </motion.div>

        <motion.h1
          variants={reduce ? undefined : child}
          className="font-display text-hero text-foreground"
        >
          Answer everything.
          <br />
          <span className="italic text-primary">Miss nothing.</span>
        </motion.h1>

        <motion.p
          variants={reduce ? undefined : child}
          className="max-w-2xl text-lg leading-relaxed text-foreground/80 sm:text-xl"
        >
          Calls, texts, DMs, invoices — drafted the second they land. You
          approve. Gradia sends. The front desk that never clocks out, for the
          price of lunch.
        </motion.p>

        <motion.div
          variants={reduce ? undefined : child}
          className="flex flex-wrap items-center gap-3 pt-1"
        >
          <Link
            href={SITE.appUrl}
            data-cursor="cta"
            className={cn(
              buttonVariants({ size: "lg" }),
              "shimmer h-13 px-6 text-base accent-glow"
            )}
          >
            Start free
            <ArrowRight className="size-4" aria-hidden />
          </Link>
          <button
            onClick={() => scrollToHash("#how")}
            data-cursor="cta"
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "h-13 px-6 text-base"
            )}
          >
            See how it works
          </button>
        </motion.div>

        <motion.p
          variants={reduce ? undefined : child}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
        >
          <span className="font-medium text-foreground">
            ${SITE.price}/month per user.
          </span>
          Keep your number, your inbox, your Stripe. Cancel anytime.
        </motion.p>
      </motion.div>

      {/* Scroll cue */}
      {!reduce && (
        <motion.button
          onClick={() => scrollToHash("#agents")}
          aria-label="Scroll to product"
          className="absolute bottom-7 left-1/2 -translate-x-1/2 text-muted-foreground/60 transition-colors hover:text-foreground"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
        >
          <motion.span
            className="block"
            animate={{ y: [0, 7, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          >
            <ChevronDown className="size-5" />
          </motion.span>
        </motion.button>
      )}
    </section>
  )
}
