"use client"

import { motion, useReducedMotion } from "framer-motion"
import { Mic, CreditCard, CalendarClock, FileText, Check } from "lucide-react"

import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

const ACTIONS = [
  { icon: FileText, label: "Look up the Smith appointment", done: true },
  { icon: CreditCard, label: "Draft Stripe invoice · $450 · Ceramic", done: true },
  { icon: CalendarClock, label: "Hold follow-up · 6 months out", done: true },
]

/**
 * Gradia Whisper explainer — the "speak it, approve it" loop. The signature
 * voice-to-action feature, rendered as a live-looking panel layered over the
 * cinematic shop photo. No fake screen recording; real markup that stays crisp.
 */
export function WhisperDemo() {
  const reduce = useReducedMotion()
  return (
    <section className="relative overflow-hidden py-24 sm:py-32">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-2">
        {/* Copy */}
        <RevealOnScroll className="space-y-5">
          <RevealItem>
            <p className="label-eyebrow flex items-center gap-2 text-muted-foreground/70">
              <span className="h-px w-6 bg-gradient-to-r from-transparent to-primary/50" />
              Gradia Whisper
            </p>
          </RevealItem>
          <RevealItem>
            <h2 className="font-display text-[clamp(1.85rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
              Finish the job. Say it once.{" "}
              <span className="italic text-primary">We do the paperwork.</span>
            </h2>
          </RevealItem>
          <RevealItem>
            <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
              Pull off your gloves, tap Whisper, and talk like you would to a
              partner. Gradia parses the intent, stages the invoice and the
              follow-up, and waits for your one tap before a cent moves.
            </p>
          </RevealItem>
          <RevealItem>
            <blockquote className="border-l-2 border-l-primary/60 pl-4 font-display text-xl italic leading-snug text-foreground/90">
              &ldquo;Charge the Smith job $450 for ceramic and rebook them in
              six months.&rdquo;
            </blockquote>
          </RevealItem>
        </RevealOnScroll>

        {/* Visual */}
        <RevealOnScroll>
          <RevealItem>
            <div className="relative overflow-hidden rounded-3xl border border-border/60">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/assets/images/feature-approval.jpg"
                alt="A detailer reviewing a Gradia approval on their phone in the shop"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />

              {/* Whisper panel */}
              <div className="absolute inset-x-4 bottom-4 sm:inset-x-6 sm:bottom-6">
                <div className="glass-card rounded-2xl p-4 shadow-2xl shadow-black/50">
                  <div className="flex items-center gap-3">
                    <span className="relative flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Mic className="size-4" />
                      {!reduce && (
                        <motion.span
                          className="absolute inset-0 rounded-full ring-2 ring-primary"
                          animate={{ scale: [1, 1.5], opacity: [0.6, 0] }}
                          transition={{ duration: 1.6, repeat: Infinity }}
                        />
                      )}
                    </span>
                    {/* Waveform */}
                    <div className="flex flex-1 items-center gap-1">
                      {Array.from({ length: 28 }).map((_, i) => (
                        <motion.span
                          key={i}
                          className="w-0.5 rounded-full bg-primary/70"
                          animate={
                            reduce
                              ? { height: 8 }
                              : { height: [4, 6 + (i % 5) * 5, 4] }
                          }
                          transition={{
                            duration: 0.9,
                            repeat: Infinity,
                            delay: i * 0.05,
                            ease: "easeInOut",
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 space-y-1.5">
                    {ACTIONS.map((a) => {
                      const Icon = a.icon
                      return (
                        <div
                          key={a.label}
                          className="flex items-center gap-2.5 rounded-lg bg-background/50 px-3 py-2 text-[13px] text-foreground/85 ring-1 ring-border/50"
                        >
                          <Icon className="size-3.5 text-primary" />
                          <span className="flex-1">{a.label}</span>
                          <Check className="size-3.5 text-emerald-400" />
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </RevealItem>
        </RevealOnScroll>
      </div>
    </section>
  )
}
