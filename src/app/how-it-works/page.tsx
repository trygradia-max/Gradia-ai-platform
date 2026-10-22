import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRight,
  BookOpen,
  Calendar,
  Check,
  Globe,
  Inbox,
  Mail,
  MessageSquare,
  Phone,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react"

import { GrainOverlay } from "@/components/gradia/grain-overlay"
import { MeshBackground } from "@/components/gradia/mesh-background"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  RevealItem,
  RevealOnScroll,
} from "@/components/gradia/motion/reveal-on-scroll"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "How Gradia works",
  description:
    "Gradia drafts replies from texts, forms, and connected inboxes, then waits for your yes.",
}

type ChannelTone = "voice" | "email" | "sms" | "calendar"

const CHANNELS: {
  icon: LucideIcon
  label: string
  body: string
  tone: ChannelTone
}[] = [
  {
    icon: MessageSquare,
    label: "Texts",
    body: "Customer texts to your business number become drafted replies in Approvals. Nothing sends until you say so.",
    tone: "sms",
  },
  {
    icon: Mail,
    label: "Email",
    body: "When the inbox is connected, inbound mail is drafted for your review. Connecting email also connects the calendar.",
    tone: "email",
  },
  {
    icon: Calendar,
    label: "Calendar",
    body: "Approved bookings can land on the connected calendar. Hard conflicts still wait for you.",
    tone: "calendar",
  },
  {
    icon: Phone,
    label: "Phone",
    body: "Phone answering is optional. It stays off until a test call sounds right.",
    tone: "voice",
  },
]

const CHANNEL_TILE: Record<ChannelTone, string> = {
  voice:
    "bg-emerald-500/12 text-emerald-500 ring-emerald-500/25 dark:text-emerald-400",
  email: "bg-sky-500/12 text-sky-500 ring-sky-500/25 dark:text-sky-400",
  sms:
    "bg-amber-500/12 text-amber-500 ring-amber-500/25 dark:text-amber-400",
  calendar:
    "bg-indigo-500/12 text-indigo-500 ring-indigo-500/25 dark:text-indigo-400",
}

const PILLARS: { icon: LucideIcon; label: string; body: string }[] = [
  {
    icon: ShieldCheck,
    label: "You approve what goes out",
    body: "Gradia can draft a reply, a quote, or a booking. Customer-facing sends wait for you unless you turn a specific action on.",
  },
  {
    icon: BookOpen,
    label: "Grounded in your shop",
    body: "Services, hours, and the notes you save are what drafts draw from — not a generic script.",
  },
  {
    icon: Sparkles,
    label: "One place to look",
    body: "Replies to review, customers, and recent activity sit on one dashboard so the next yes is obvious.",
  },
  {
    icon: Inbox,
    label: "Honest status",
    body: "A channel is ready only when the evidence says so. Setup is never described as live.",
  },
]

const FLOW: { title: string; body: string }[] = [
  {
    title: "A customer writes in",
    body: "A text, a website form, or a connected inbox. Gradia files the person and the request.",
  },
  {
    title: "A reply is drafted",
    body: "The draft uses the shop's services and voice. Nothing is sent yet.",
  },
  {
    title: "You review it",
    body: "Approvals holds the card. Approve, edit, or drop it.",
  },
  {
    title: "Then it can go out",
    body: "Only the action you approved runs. The customer record stays in one place.",
  },
]

const FEATURES: string[] = [
  "Drafted texts waiting in Approvals",
  "Website form intake",
  "Connected email drafts, when email is set up",
  "Customers, vehicles, and conversation history",
  "Quotes and bookings from the shop menu",
  "Ask Gradia for shop questions — it does not text customers",
  "Optional phone answering after a test call",
  "You approve what leaves the shop",
]

export default function HowItWorksPage() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <GrainOverlay />
      <TopNav />

      <main className="relative">
        {/* Hero — full-bleed mesh background like the login canvas, so
         *  marketing → app feels like one continuous design. */}
        <section className="relative isolate overflow-hidden px-4 pb-20 pt-16 sm:px-6 sm:pb-28 sm:pt-24">
          <MeshBackground />

          <div className="mx-auto flex max-w-4xl flex-col items-center gap-7 text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/40 bg-card/60 px-3 py-1 backdrop-blur-sm">
              <span className="flex size-4 items-center justify-center rounded bg-primary/15 text-primary ring-1 ring-primary/25">
                <Sparkles className="size-2.5" aria-hidden />
              </span>
              <span className="label-eyebrow !text-muted-foreground/80">
                For working detail shops
              </span>
            </span>

            <h1 className="font-display text-[clamp(2.5rem,7vw,5rem)] leading-[1.02] tracking-[-0.03em] text-foreground">
              Catch every lead, then{" "}
              <span className="italic">approve what goes out</span>.
            </h1>

            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Gradia drafts replies from texts, website forms, and a connected
              inbox, then waits for your yes before anything leaves the shop.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <Link
                href="/login"
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "h-12 gap-2 px-5"
                )}
              >
                Start the pilot
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link
                href="#channels"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "h-12 px-5"
                )}
              >
                See what it does
              </Link>
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-5xl space-y-24 px-4 pb-24 sm:space-y-32 sm:px-6">
          {/* Channels */}
          <section id="channels" className="scroll-mt-24 space-y-8">
            <SectionLead
              eyebrow="Channels"
              title={
                <>
                  Every way a customer can{" "}
                  <span className="italic">reach you</span>.
                </>
              }
              subtitle="Start with texts and website forms. Email, calendar, and phone each have their own setup — none of them turn on just because you signed in."
            />
            <RevealOnScroll
              as="ul"
              className="grid gap-3 sm:grid-cols-2"
            >
              {CHANNELS.map((ch) => {
                const Icon = ch.icon
                return (
                  <RevealItem key={ch.label}>
                    <MotionCard
                      interactive
                      className="h-full p-5 sm:p-6"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
                            CHANNEL_TILE[ch.tone]
                          )}
                        >
                          <Icon className="size-[18px]" aria-hidden />
                        </div>
                        <div className="min-w-0 space-y-1.5">
                          <h3 className="font-display text-lg leading-tight tracking-tight text-foreground">
                            {ch.label}
                          </h3>
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {ch.body}
                          </p>
                        </div>
                      </div>
                    </MotionCard>
                  </RevealItem>
                )
              })}
            </RevealOnScroll>
          </section>

          {/* How it flows — vertical timeline with connecting rail */}
          <section className="space-y-8">
            <SectionLead
              eyebrow="How a lead flows"
              title={
                <>
                  From the first message to a booking, with you in the{" "}
                  <span className="italic">loop</span>.
                </>
              }
              subtitle="Gradia drafts. You decide. Customer-facing sends wait for approval."
            />
            <RevealOnScroll className="relative">
              {/* Connecting rail behind the step dots. */}
              <span
                aria-hidden
                className="absolute left-3.5 top-2 bottom-2 w-px bg-gradient-to-b from-primary/30 via-border to-transparent sm:left-4"
              />
              <ol className="space-y-5">
                {FLOW.map((step, i) => (
                  <RevealItem key={i}>
                    <li className="relative flex gap-4 sm:gap-5">
                      <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary ring-1 ring-primary/30 sm:size-8 sm:text-xs">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1 pb-2">
                        <h3 className="font-display text-lg leading-tight tracking-tight text-foreground sm:text-xl">
                          {step.title}
                        </h3>
                        <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
                          {step.body}
                        </p>
                      </div>
                    </li>
                  </RevealItem>
                ))}
              </ol>
            </RevealOnScroll>
          </section>

          {/* Pillars */}
          <section className="space-y-8">
            <SectionLead
              eyebrow="What makes it different"
              title={
                <>
                  Built for{" "}
                  <span className="italic">shops</span>, not for demos.
                </>
              }
              subtitle="Four design choices we made early and don't intend to walk back."
            />
            <RevealOnScroll
              as="ul"
              className="grid gap-3 sm:grid-cols-2"
            >
              {PILLARS.map((p) => {
                const Icon = p.icon
                return (
                  <RevealItem key={p.label}>
                    <MotionCard interactive className="h-full p-5 sm:p-6">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
                          <Icon className="size-[18px]" aria-hidden />
                        </div>
                        <div className="min-w-0 space-y-1.5">
                          <h3 className="font-display text-lg leading-tight tracking-tight text-foreground">
                            {p.label}
                          </h3>
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {p.body}
                          </p>
                        </div>
                      </div>
                    </MotionCard>
                  </RevealItem>
                )
              })}
            </RevealOnScroll>
          </section>

          {/* What you get */}
          <section className="space-y-8">
            <SectionLead
              eyebrow="What you get"
              title={
                <>
                  What the pilot actually{" "}
                  <span className="italic">covers</span>.
                </>
              }
              subtitle="The working loop for a detailing shop. Payments, full work orders, and review-request texts are not part of this."
            />
            <RevealOnScroll
              as="ul"
              className="grid gap-2 text-sm sm:grid-cols-2"
            >
              {FEATURES.map((item) => (
                <RevealItem
                  key={item}
                  className="flex items-start gap-2.5 rounded-lg border border-border/40 bg-card/40 px-3.5 py-2.5"
                >
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/30 dark:text-emerald-400">
                    <Check className="size-2.5" aria-hidden />
                  </span>
                  <span className="text-foreground/90">{item}</span>
                </RevealItem>
              ))}
            </RevealOnScroll>
          </section>

          {/* Pricing */}
          <section>
            <RevealOnScroll>
              <RevealItem>
                <div className="relative isolate overflow-hidden rounded-3xl border border-border/60 bg-card/40 p-7 sm:p-12">
                  <MeshBackground />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
                  />
                  <div className="relative grid gap-6 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-10">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Inbox className="size-3.5 text-primary" aria-hidden />
                        <p className="label-eyebrow text-muted-foreground/80">
                          Pilot pricing
                        </p>
                      </div>
                      <h2 className="font-display text-[clamp(2rem,5.5vw,3.25rem)] leading-[1.02] tracking-[-0.025em] text-foreground">
                        Come in, then{" "}
                        <span className="italic">approve what goes out</span>.
                      </h2>
                      <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
                        Sign in to finish setup. Channels are connected
                        one at a time, and nothing sends until you approve it.
                      </p>
                    </div>
                    <Link
                      href="/login"
                      className={cn(
                        buttonVariants({ size: "lg" }),
                        "h-12 shrink-0 gap-2 px-5"
                      )}
                    >
                      Start the pilot
                      <ArrowRight className="size-4" aria-hidden />
                    </Link>
                  </div>
                </div>
              </RevealItem>
            </RevealOnScroll>
          </section>
        </div>

        <footer className="border-t border-border/40 bg-background/60">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="flex items-center gap-2">
              <Globe className="size-3" aria-hidden />
              trygradia.com — built for working detail shops.
            </p>
            <p>© {new Date().getFullYear()} Gradia</p>
          </div>
        </footer>
      </main>
    </div>
  )
}

function TopNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/40 bg-background/70 backdrop-blur-md supports-backdrop-filter:bg-background/55">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link
          href="/"
          className="group inline-flex items-center gap-2 rounded-full border border-border/40 bg-card/60 px-2.5 py-1 backdrop-blur-sm transition-colors hover:border-border"
        >
          <span className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary ring-1 ring-primary/25">
            <Sparkles className="size-2.5" aria-hidden />
          </span>
          <span className="font-display text-sm tracking-tight text-foreground">
            Gradia
          </span>
        </Link>
        <div className="flex items-center gap-1.5">
          <Link
            href="/login"
            className={cn(buttonVariants({ variant: "ghost" }), "h-9")}
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className={cn(buttonVariants({ size: "default" }), "h-9 gap-1.5")}
          >
            Get started
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </div>
    </header>
  )
}

function SectionLead({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string
  title: React.ReactNode
  subtitle: string
}) {
  return (
    <RevealOnScroll className="max-w-2xl space-y-2.5">
      <RevealItem>
        <p className="label-eyebrow text-muted-foreground/70">{eyebrow}</p>
      </RevealItem>
      <RevealItem>
        <h2 className="font-display text-[clamp(1.75rem,4vw,2.5rem)] leading-[1.05] tracking-[-0.02em] text-foreground">
          {title}
        </h2>
      </RevealItem>
      <RevealItem>
        <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
          {subtitle}
        </p>
      </RevealItem>
    </RevealOnScroll>
  )
}
