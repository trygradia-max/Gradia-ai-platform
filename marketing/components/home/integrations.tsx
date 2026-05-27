import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

const LOGOS = [
  { src: "/assets/logos/gmail.svg", alt: "Gmail" },
  { src: "/assets/logos/twilio.svg", alt: "Twilio" },
  { src: "/assets/logos/stripe.svg", alt: "Stripe" },
  { src: "/assets/logos/instagram.svg", alt: "Instagram" },
  { src: "/assets/logos/slack.svg", alt: "Slack" },
]

/**
 * Logo wall — the office layer on top of the operator's own accounts.
 * Real brand marks, rendered monochrome and lifted to full color on
 * hover (the classic premium "logo grid" treatment). Vapi / Calendar /
 * Jobber have no mainstream mark, so they ride a quiet supporting line.
 */
export function Integrations() {
  return (
    <section className="relative border-y border-border/40 bg-card/15 py-12">
      <RevealOnScroll className="mx-auto max-w-5xl px-5 sm:px-8">
        <RevealItem>
          <p className="label-eyebrow text-center text-muted-foreground/60">
            Works with the tools already in your shop
          </p>
        </RevealItem>
        <RevealItem>
          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-12 gap-y-7 sm:gap-x-16">
            {LOGOS.map((logo) => (
              <li key={logo.alt}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logo.src}
                  alt={logo.alt}
                  className="h-7 w-auto opacity-45 grayscale transition-all duration-300 hover:scale-105 hover:opacity-100 hover:grayscale-0 sm:h-8"
                />
              </li>
            ))}
          </ul>
        </RevealItem>
        <RevealItem>
          <p className="mt-7 text-center text-xs text-muted-foreground/50">
            Plus Vapi for voice, Google Calendar for booking, and Jobber for CRM.
          </p>
        </RevealItem>
      </RevealOnScroll>
    </section>
  )
}
