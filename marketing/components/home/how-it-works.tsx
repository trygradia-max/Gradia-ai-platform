"use client"

import * as React from "react"
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "framer-motion"
import { Calendar, Check, Send } from "lucide-react"

import { cn } from "@/lib/utils"
import { ApprovalCard } from "@/components/home/approval-card"

const STEPS = [
  {
    title: "It comes in",
    body: "A call, an email, a text, a DM. Gradia catches it on every channel — no matter which one, no matter the hour.",
  },
  {
    title: "We draft it",
    body: "Classified, logged to shared memory, and written in your shop's voice — quoting your real menu, not generic AI filler.",
  },
  {
    title: "You approve it",
    body: "A card hits your phone. Approve, tweak, or kill it. One tap. Nothing customer-facing moves without you.",
  },
  {
    title: "It ships",
    body: "Reply sends, lead lands, calendar updates, invoice goes out — every touch filed on one customer record.",
  },
]

function SentCard() {
  return (
    <div className="glass-card w-full max-w-sm overflow-hidden rounded-2xl shadow-2xl shadow-black/40">
      <div className="flex items-center gap-3 border-b border-border/60 px-5 py-3.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/25">
          <Check className="size-4" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">
            Marcus R. · Tesla Model S
          </p>
          <p className="text-[11px] text-muted-foreground">
            Approved by you · sent in 3s
          </p>
        </div>
        <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-emerald-500/20">
          Done
        </span>
      </div>
      <div className="space-y-2.5 px-5 py-4">
        {[
          { icon: Send, label: "Reply sent to Marcus" },
          { icon: Calendar, label: "Booked · Sat 9:00am · Ceramic coating" },
          { icon: Check, label: "Lead filed · shared memory updated" },
        ].map((row) => {
          const Icon = row.icon
          return (
            <div
              key={row.label}
              className="flex items-center gap-3 rounded-xl bg-background/60 px-3.5 py-2.5 text-sm text-foreground/85 ring-1 ring-border/50"
            >
              <Icon className="size-4 text-emerald-400" />
              {row.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function HowItWorks() {
  const reduce = useReducedMotion()
  const ref = React.useRef<HTMLDivElement>(null)
  const [active, setActive] = React.useState(0)

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  })

  useMotionValueEvent(scrollYProgress, "change", (v) => {
    const idx = Math.min(STEPS.length - 1, Math.floor(v * STEPS.length))
    setActive(idx)
  })

  const Visual = (
    <div className="relative flex items-center justify-center">
      {/* Soft accent halo behind the card */}
      <div
        aria-hidden
        className="absolute size-72 rounded-full bg-primary/10 blur-3xl"
      />
      <AnimatePresence mode="wait">
        {active < 3 ? (
          <motion.div
            key="pending"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="relative"
          >
            <ApprovalCard
              channel="voice"
              customer="Marcus R."
              vehicle="Tesla Model S"
              inbound="Hey, what do you charge for a ceramic coating on a Model S? Trying to book this weekend."
              draft="Hi Marcus — we'd do the Model S ceramic at $1,200, about 6 hours. We've got Saturday 9am open. Want me to hold it? — Gradia, front desk at Apex Detail"
              meta="Cross-channel: Marcus also DM'd on Instagram 2 days ago."
            />
          </motion.div>
        ) : (
          <motion.div
            key="sent"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="relative"
          >
            <SentCard />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )

  // Reduced motion / no-pin fallback: simple stacked two-column layout.
  if (reduce) {
    return (
      <section id="how" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-24 sm:px-8">
        <Header />
        <div className="mt-12 grid gap-10 lg:grid-cols-2">
          <ol className="space-y-8">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary ring-1 ring-primary/30">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-display text-xl text-foreground">
                    {s.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          {Visual}
        </div>
      </section>
    )
  }

  return (
    <section
      id="how"
      ref={ref}
      className="relative scroll-mt-24"
      style={{ height: `${STEPS.length * 90}vh` }}
    >
      <div className="sticky top-0 flex h-screen items-center overflow-hidden">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-2">
          {/* Steps column */}
          <div>
            <Header />
            <ol className="mt-10 space-y-6">
              {STEPS.map((s, i) => {
                const on = i === active
                return (
                  <li key={s.title} className="flex gap-4">
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 transition-all duration-300",
                        on
                          ? "bg-primary text-primary-foreground ring-primary"
                          : "bg-card text-muted-foreground ring-border"
                      )}
                    >
                      {i + 1}
                    </span>
                    <motion.div
                      animate={{ opacity: on ? 1 : 0.4 }}
                      transition={{ duration: 0.3 }}
                    >
                      <h3 className="font-display text-xl leading-tight tracking-tight text-foreground sm:text-2xl">
                        {s.title}
                      </h3>
                      <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                        {s.body}
                      </p>
                    </motion.div>
                  </li>
                )
              })}
            </ol>
          </div>

          {/* Pinned visual */}
          <div className="hidden lg:block">{Visual}</div>
        </div>
      </div>
    </section>
  )
}

function Header() {
  return (
    <>
      <p className="label-eyebrow flex items-center gap-2 text-muted-foreground/70">
        <span className="h-px w-6 bg-gradient-to-r from-transparent to-primary/50" />
        How a lead flows
      </p>
      <h2 className="mt-3 max-w-xl font-display text-[clamp(2.1rem,5vw,3.5rem)] leading-[1.02] tracking-[-0.03em] text-foreground">
        Catch it. Draft it. Approve it.{" "}
        <span className="italic text-primary">Done.</span>
      </h2>
    </>
  )
}
