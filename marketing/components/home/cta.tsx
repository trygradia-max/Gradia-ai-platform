import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { SITE } from "@/lib/site"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { GrainOverlay, MeshBackground } from "@/components/textures"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

/** Closing call-to-action — big mesh panel, honest $20 line, glowing CTA. */
export function CTA() {
  return (
    <section className="mx-auto max-w-6xl px-5 sm:px-8">
      <RevealOnScroll>
        <RevealItem>
          <div className="animated-border glow-breathe relative isolate overflow-hidden rounded-[2rem] border border-border/60 px-6 py-16 text-center sm:px-12 sm:py-24">
            <MeshBackground />
            <GrainOverlay />

            <p className="label-eyebrow mx-auto text-muted-foreground/70">
              ${SITE.price}/month · per user · cancel anytime
            </p>
            <h2 className="mx-auto mt-4 max-w-3xl font-display text-[clamp(2.5rem,7vw,4.75rem)] leading-[1.0] tracking-[-0.035em] text-foreground">
              Answer the next call.{" "}
              <span className="italic text-primary">Book the next job.</span>
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Keep your number, your inbox, your Stripe. Gradia works the front
              desk around them — and never sleeps through a call you&apos;d have
              missed.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href={SITE.appUrl}
                data-cursor="cta"
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "shimmer h-13 px-6 text-base"
                )}
              >
                Start free
                <ArrowRight className="size-4" aria-hidden />
              </Link>
              <Link
                href="/pricing"
                data-cursor="cta"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "h-13 px-6 text-base"
                )}
              >
                See pricing
              </Link>
            </div>
          </div>
        </RevealItem>
      </RevealOnScroll>
    </section>
  )
}
