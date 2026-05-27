"use client"

import { Quote, Star } from "lucide-react"
import { motion, useReducedMotion } from "framer-motion"

import { Counter } from "@/components/motion/counter"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"
import { MotionCard } from "@/components/motion/motion-card"

type Testimonial = {
  quote: string
  name: string
  role: string
  avatar: string
}

const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "I used to lose half my Saturdays to voicemail tag. Now the call gets answered, the quote's already drafted, and I just tap approve between jobs. It feels like I hired someone — except it knows my menu cold.",
    name: "Elena Castro",
    role: "Owner · Castro Detail Studio",
    avatar: "/assets/images/avatar-elena.jpg",
  },
  {
    quote:
      "The cross-channel thing is what got me. A guy DM'd, then called two days later — Gradia already knew. I sounded like I'd been waiting for him. That's a booked ceramic I'd have fumbled before.",
    name: "Marcus Reed",
    role: "Apex Detail",
    avatar: "/assets/images/avatar-marcus.jpg",
  },
  {
    quote:
      "I was scared an AI would say something dumb to a customer. It can't — nothing sends till I say so. So I get the speed without the risk. That's the whole reason I trust it on the phone.",
    name: "Ray Whitfield",
    role: "Whitfield Mobile Detailing",
    avatar: "/assets/images/avatar-ray.jpg",
  },
]

const METRICS: { value: number; prefix?: string; suffix: string; label: string }[] =
  [
    { value: 24, suffix: "/7", label: "Coverage across every channel" },
    { value: 3, suffix: "s", label: "From inbound to a drafted reply" },
    { value: 100, suffix: "%", label: "Outbound passes through you" },
    { value: 0, suffix: "", label: "Leads left on voicemail" },
  ]

export function SocialProof() {
  const reduce = useReducedMotion()
  return (
    <section className="relative overflow-hidden py-24 sm:py-32">
      {/* Layered color depth */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 50% 60% at 80% 10%, oklch(0.72 0.18 35 / 0.07), transparent 60%)",
        }}
      />
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-col gap-3">
          <p className="label-eyebrow flex items-center gap-2 text-muted-foreground/70">
            <span className="h-px w-6 bg-gradient-to-r from-transparent to-primary/50" />
            From the bay
          </p>
          <h2 className="max-w-3xl font-display text-[clamp(2.1rem,5vw,3.5rem)] leading-[1.02] tracking-[-0.03em] text-foreground">
            Built in the bay.{" "}
            <span className="italic text-primary">Not a boardroom.</span>
          </h2>
        </div>

        {/* Testimonials — staggered, slightly offset for editorial tension */}
        <RevealOnScroll
          as="ul"
          className="mt-12 grid gap-5 md:grid-cols-3"
        >
          {TESTIMONIALS.map((t, i) => (
            <RevealItem key={t.name} className={i === 1 ? "md:mt-10" : i === 2 ? "md:mt-5" : ""}>
              <MotionCard glow className="flex h-full flex-col gap-5 p-7">
                <div className="flex items-center justify-between">
                  <Quote className="size-7 text-primary/40" aria-hidden />
                  <div className="flex gap-0.5">
                    {Array.from({ length: 5 }).map((_, s) => (
                      <Star
                        key={s}
                        className="size-3.5 fill-primary text-primary"
                        aria-hidden
                      />
                    ))}
                  </div>
                </div>
                <p className="flex-1 text-[15px] leading-relaxed text-foreground/90">
                  {t.quote}
                </p>
                <div className="flex items-center gap-3 border-t border-border/50 pt-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.avatar}
                    alt={t.name}
                    className="size-11 rounded-full object-cover ring-1 ring-border"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {t.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t.role}
                    </p>
                  </div>
                </div>
              </MotionCard>
            </RevealItem>
          ))}
        </RevealOnScroll>

        {/* Metric strip */}
        <motion.ul
          initial={reduce ? undefined : { opacity: 0, y: 20 }}
          whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border/50 bg-border/40 lg:grid-cols-4"
        >
          {METRICS.map((m) => (
            <li
              key={m.label}
              className="flex flex-col gap-1.5 bg-background/70 p-6 backdrop-blur-sm"
            >
              <span className="font-display text-[clamp(2rem,4.5vw,2.75rem)] leading-none tracking-tight text-foreground">
                {m.prefix}
                <Counter value={m.value} />
                <span className="text-primary">{m.suffix}</span>
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                {m.label}
              </span>
            </li>
          ))}
        </motion.ul>
      </div>
    </section>
  )
}
