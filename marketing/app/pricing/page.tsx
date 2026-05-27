import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, Check, Building2 } from "lucide-react"

import { SITE } from "@/lib/site"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { GrainOverlay, MeshBackground } from "@/components/textures"
import { SectionHeading } from "@/components/section-heading"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"
import { MotionCard } from "@/components/motion/motion-card"

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "One plan. $20/month per user. Every agent, the full approval queue, shared memory across channels. Bring your own integrations, cancel anytime.",
}

const INCLUDED: { group: string; items: string[] }[] = [
  {
    group: "Every agent, on day one",
    items: [
      "Voice receptionist (Vapi)",
      "Email assistant (Gmail · Aurinko)",
      "SMS assistant (Twilio)",
      "Instagram DM agent (Meta)",
      "Booking agent (Calendar + reminders)",
      "Billing agent + Gradia Whisper (Stripe)",
      "Memory & insights (Ask Gradia)",
    ],
  },
  {
    group: "The whole office",
    items: [
      "Human-in-the-loop on everything outbound",
      "Slack approvals — Approve / Edit / Reject",
      "Shared memory across every channel",
      "Heat-scored lead pipeline",
      "Custom agents — schedule or event triggered",
      "Shop-knowledge RAG (cites your real policies)",
      "Co-owner widget — proactive follow-up nudges",
    ],
  },
]

const FAQ: { q: string; a: string }[] = [
  {
    q: "What do I need to bring?",
    a: "Your own accounts: a Vapi number, a Gmail inbox, a Twilio number, a Stripe account, and a Meta page if you want DMs. Gradia is the office layer that ties them together — you keep ownership of every account and every number.",
  },
  {
    q: "Is it really $20 a month?",
    a: "Yes — $20/month per user, flat. You pay your own usage on the services you connect (Vapi minutes, Twilio messages, Stripe fees). We don't mark those up.",
  },
  {
    q: "Will it send anything without me seeing it?",
    a: "No. Every customer-facing action — replies, invoices, bookings, reminders — is drafted and queued for your one-tap approval in Slack. Nothing outbound ships until you approve it.",
  },
  {
    q: "Can I cancel and take my data?",
    a: "Cancel anytime. Your customer records, interactions, and history export cleanly — it's your shop's data, not ours.",
  },
  {
    q: "Does the Heat Score actually predict who'll buy?",
    a: "It's an honest, transparent heuristic — lead age, status, recent activity, whether they've replied, and repeat-customer signal. No black-box model claiming to read the future.",
  },
]

export default function PricingPage() {
  return (
    <>
      <section className="relative isolate overflow-hidden px-5 pt-36 pb-16 sm:px-8 sm:pt-44">
        <MeshBackground />
        <GrainOverlay />
        <div className="mx-auto max-w-3xl text-center">
          <p className="label-eyebrow justify-center text-muted-foreground/70">
            Pricing
          </p>
          <h1 className="mt-4 font-display text-[clamp(2.75rem,8vw,5.25rem)] leading-[1.0] tracking-[-0.04em] text-foreground">
            One plan. Everything on.{" "}
            <span className="italic text-primary">$20.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Every agent. The full approval queue. Shared memory across every
            channel. Same price whether you run one bay or five.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 sm:px-8">
        <RevealOnScroll className="grid items-start gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          {/* The plan */}
          <RevealItem>
            <MotionCard
              interactive={false}
              className="animated-border relative overflow-hidden p-8 accent-glow sm:p-10"
            >
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="label-eyebrow text-primary">The Gradia plan</p>
                  <div className="mt-3 flex items-baseline gap-1.5">
                    <span className="font-display text-6xl tracking-tight text-foreground">
                      ${SITE.price}
                    </span>
                    <span className="text-muted-foreground">/ month · per user</span>
                  </div>
                </div>
                <Link
                  href={SITE.appUrl}
                  data-cursor="cta"
                  className={cn(buttonVariants({ size: "lg" }), "h-12 px-6")}
                >
                  Start free
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </div>

              <p className="mt-5 max-w-lg text-sm leading-relaxed text-muted-foreground">
                Bring your own number, inbox, Stripe, and Meta page. Cancel
                anytime — your data exports cleanly.
              </p>

              <div className="mt-8 grid gap-8 sm:grid-cols-2">
                {INCLUDED.map((col) => (
                  <div key={col.group} className="space-y-3.5">
                    <p className="label-eyebrow text-muted-foreground/60">
                      {col.group}
                    </p>
                    <ul className="space-y-2.5">
                      {col.items.map((item) => (
                        <li
                          key={item}
                          className="flex items-start gap-2.5 text-sm text-foreground/85"
                        >
                          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/25">
                            <Check className="size-2.5" aria-hidden />
                          </span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </MotionCard>
          </RevealItem>

          {/* Scale panel */}
          <RevealItem>
            <MotionCard className="flex h-full flex-col p-8">
              <div className="flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
                <Building2 className="size-5" aria-hidden />
              </div>
              <h2 className="mt-5 font-display text-2xl leading-tight tracking-tight text-foreground">
                Running multiple locations?
              </h2>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted-foreground">
                Multi-shop routing, shared knowledge across bays, and per-location
                reporting are on the roadmap. Tell us how your operation is set up
                and we&apos;ll shape the pilot around it.
              </p>
              <Link
                href={SITE.appUrl}
                data-cursor="cta"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "mt-6 h-12"
                )}
              >
                Talk to us
              </Link>
            </MotionCard>
          </RevealItem>
        </RevealOnScroll>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-5 py-28 sm:px-8">
        <SectionHeading
          eyebrow="Questions"
          title={
            <>
              The fine print, <span className="italic text-primary">in plain English</span>.
            </>
          }
          align="center"
        />
        <RevealOnScroll className="mt-12 space-y-3">
          {FAQ.map((f) => (
            <RevealItem key={f.q}>
              <div className="rounded-2xl border border-border/60 bg-card/50 p-6">
                <h3 className="font-display text-lg tracking-tight text-foreground">
                  {f.q}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {f.a}
                </p>
              </div>
            </RevealItem>
          ))}
        </RevealOnScroll>
      </section>
    </>
  )
}
