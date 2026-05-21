import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRight,
  AtSign,
  BookOpen,
  Bot,
  Calendar,
  CheckCircle2,
  CreditCard,
  Globe,
  Inbox,
  Mail,
  MessageSquare,
  Phone,
  ShieldCheck,
  Sparkles,
} from "lucide-react"

import { buttonVariants } from "@/components/ui/button"

export const metadata: Metadata = {
  title: "How Gradia works",
  description:
    "Gradia is the AI office for auto detailing shops — every call, email, text, and DM becomes a Slack approval card you can act on from your phone.",
}

const CHANNELS = [
  {
    icon: Phone,
    label: "Voice",
    body: "A real receptionist (Vapi-powered) takes the call, quotes services from your menu, and proposes bookings — even when you're under a car.",
  },
  {
    icon: Mail,
    label: "Email",
    body: "Gmail-via-Aurinko. Every inbound inquiry is classified, an on-brand reply is drafted, and one tap in Slack sends it.",
  },
  {
    icon: MessageSquare,
    label: "SMS",
    body: "Your Twilio number captures texts, auto-drafts replies, and sends booking reminders 24 hours before each appointment.",
  },
  {
    icon: AtSign,
    label: "Instagram + Facebook DMs",
    body: "Page messages get the same HITL flow as everything else — proposed drafts, your approval, sent in seconds.",
  },
  {
    icon: Calendar,
    label: "Calendar",
    body: "Approved bookings drop straight into your Google Calendar. Same Aurinko OAuth covers email and calendar.",
  },
  {
    icon: CreditCard,
    label: "Payments",
    body: "Stripe Connect. Whisper \"charge Smith $450 for ceramic\" from your phone — we draft the invoice, you approve, Stripe sends it.",
  },
] as const

const PILLARS = [
  {
    icon: Bot,
    label: "Agentic with guardrails",
    body: "Gradia drafts everything — leads, replies, invoices, reminders. Nothing outbound ships until you approve it in Slack or the dashboard. One bad message is real money, so the human is always in the loop.",
  },
  {
    icon: BookOpen,
    label: "Grounded in your shop",
    body: "Paste your deposit rules, weather policy, hours, brand voice — Gradia's drafters and voice agent quote your actual words, not Claude's training data.",
  },
  {
    icon: Sparkles,
    label: "Proactive co-owner",
    body: "Open the dashboard and Gradia tells you who to follow up on: hot leads we haven't pinged, customers gone quiet, appointments coming up. One tap drafts the message.",
  },
  {
    icon: ShieldCheck,
    label: "Honest scoring",
    body: "Heat score is a transparent heuristic — age, status, recent activity, inbound response, repeat-customer signal. No black-box ML claiming to predict the future.",
  },
] as const

const FLOW = [
  "Customer reaches out — phone call, email, text, or DM.",
  "Gradia classifies the message, records it in the shared memory layer, and drafts a reply on-brand.",
  "A Slack card appears: Approve, Edit, or Reject.",
  "One tap — the message sends, the lead lands, the calendar updates, the invoice goes out.",
  "Every touchpoint across every channel stays linked to one customer record. We don't forget anything.",
] as const

export default function HowItWorksPage() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/65">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
              <Sparkles className="size-4" aria-hidden />
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Gradia
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className={`${buttonVariants({ variant: "ghost" })} h-9`}
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className={`${buttonVariants({ variant: "default" })} h-9`}
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-20 px-4 py-12 sm:space-y-24 sm:px-6 sm:py-16">
        <section className="space-y-5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            <Sparkles className="size-3" aria-hidden />
            For auto detailing shops
          </span>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            The AI office that catches every lead while you&apos;re
            <span className="text-primary"> under a car.</span>
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Gradia answers your phone, reads your inbox, replies to your
            DMs, and texts back leads — then puts everything in front of
            you as a one-tap Slack approval. No more missed calls,
            forgotten quotes, or &ldquo;I&apos;ll get back to you tomorrow.&rdquo;
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Link
              href="/login"
              className={`${buttonVariants({ variant: "default" })} h-11`}
            >
              Start the pilot
              <ArrowRight className="size-4" aria-hidden />
            </Link>
            <Link
              href="#channels"
              className={`${buttonVariants({ variant: "outline" })} h-11`}
            >
              See what it does
            </Link>
          </div>
        </section>

        <section id="channels" className="space-y-6 scroll-mt-20">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Channels
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Every way a customer can reach you, in one place.
            </h2>
            <p className="max-w-2xl text-muted-foreground">
              Gradia plugs into the tools you already use — Vapi for
              voice, Gmail for email, Twilio for SMS, Meta for DMs,
              Stripe for payments. Each one shows up as a card on your
              dashboard with a connect button.
            </p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {CHANNELS.map((ch) => {
              const Icon = ch.icon
              return (
                <li
                  key={ch.label}
                  className="rounded-lg border border-border/60 bg-muted/10 p-4"
                >
                  <div className="flex items-center gap-2.5 pb-1">
                    <div className="flex size-8 items-center justify-center rounded-md bg-background">
                      <Icon className="size-4 text-primary" aria-hidden />
                    </div>
                    <p className="text-base font-medium">{ch.label}</p>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {ch.body}
                  </p>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="space-y-6">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              How a lead flows
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              From inquiry to invoice, with you in the loop the whole way.
            </h2>
          </div>
          <ol className="grid gap-2">
            {FLOW.map((step, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/10 px-4 py-3"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                  {i + 1}
                </span>
                <p className="text-sm leading-relaxed">{step}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="space-y-6">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              What makes it different
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Built for shops, not for demos.
            </h2>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {PILLARS.map((p) => {
              const Icon = p.icon
              return (
                <li
                  key={p.label}
                  className="rounded-lg border border-border/60 bg-muted/10 p-4"
                >
                  <div className="flex items-center gap-2.5 pb-1">
                    <div className="flex size-8 items-center justify-center rounded-md bg-background">
                      <Icon className="size-4 text-primary" aria-hidden />
                    </div>
                    <p className="text-base font-medium">{p.label}</p>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {p.body}
                  </p>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="space-y-6">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              What you get
            </p>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              The whole office, one dashboard.
            </h2>
          </div>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {[
              "Voice receptionist via Vapi — books, quotes, captures leads",
              "Email + Calendar via Aurinko — inbound classifier + auto-drafts",
              "Twilio SMS — inbound + outbound + delivery callbacks",
              "Instagram & Facebook DMs — same HITL flow as the rest",
              "Stripe Connect — invoice from inside Gradia",
              "Shared customer memory across every channel",
              "Heat-scored lead pipeline",
              "Co-owner widget — proactive nudges on what to do next",
              "BI chat — ask anything about your business",
              "Custom agents — schedule or event-triggered workflows",
              "Shop knowledge RAG — drafters cite your real policies",
              "Slack-native approvals with Approve / Edit / Reject",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2">
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-border/60 bg-muted/10 p-6 sm:p-10">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Inbox className="size-4 text-primary" aria-hidden />
                <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  Pilot pricing
                </p>
              </div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                $20/mo. No catch.
              </h2>
              <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
                You bring your own Vapi number, Gmail, Twilio number,
                Stripe, and Meta page. We handle the AI office layer
                that ties them together. Cancel any time — your data
                exports cleanly.
              </p>
            </div>
            <Link
              href="/login"
              className={`${buttonVariants({ variant: "default" })} h-11 sm:h-10`}
            >
              Start the pilot
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        </section>

        <footer className="flex flex-col gap-2 border-t border-border/60 pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2">
            <Globe className="size-3" aria-hidden />
            trygradia.com — built for working detail shops.
          </p>
          <p>© {new Date().getFullYear()} Gradia</p>
        </footer>
      </main>
    </div>
  )
}
