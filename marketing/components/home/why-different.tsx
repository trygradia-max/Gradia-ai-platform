import { Bot, BookOpen, Sparkles, ShieldCheck, type LucideIcon } from "lucide-react"

import { SectionHeading } from "@/components/section-heading"
import { MotionCard } from "@/components/motion/motion-card"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

const PILLARS: { icon: LucideIcon; label: string; body: string }[] = [
  {
    icon: Bot,
    label: "Agentic, with guardrails",
    body: "Gradia drafts everything — leads, replies, invoices, reminders. Nothing outbound ships until you approve it. One bad message is real money, so a human is always in the loop.",
  },
  {
    icon: BookOpen,
    label: "Grounded in your shop",
    body: "Paste your deposit rules, weather policy, hours, and brand voice. Gradia quotes your actual words and your live menu — not a model's training data.",
  },
  {
    icon: Sparkles,
    label: "A proactive co-owner",
    body: "Open the dashboard and Gradia tells you who to follow up on — hot leads, customers gone quiet, appointments coming up. One tap drafts the message.",
  },
  {
    icon: ShieldCheck,
    label: "Honest scoring",
    body: "Heat Score is a transparent heuristic — lead age, status, recent activity, response, repeat-customer signal. No black-box ML pretending to predict the future.",
  },
]

/**
 * The "built for shops, not demos" trust band. These are the product's
 * stated design choices (PROJECT_BRIEF / how-it-works), framed as
 * differentiators — the marketing equivalent of social proof for a tool
 * that respects the operator.
 */
export function WhyDifferent() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-24 sm:px-8 sm:py-32">
      <SectionHeading
        eyebrow="What makes it different"
        title={
          <>
            Built for the bay.{" "}
            <span className="italic text-primary">Not the demo.</span>
          </>
        }
        subtitle="Four calls we made early and won't walk back."
      />

      <RevealOnScroll as="ul" className="mt-12 grid gap-4 sm:grid-cols-2">
        {PILLARS.map((p) => {
          const Icon = p.icon
          return (
            <RevealItem key={p.label}>
              <MotionCard glow className="h-full p-7">
                <div className="flex items-start gap-4">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
                    <Icon className="size-5" aria-hidden />
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-display text-xl leading-tight tracking-tight text-foreground">
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
  )
}
