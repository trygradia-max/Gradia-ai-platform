import { STATS } from "@/lib/site"
import { Counter } from "@/components/motion/counter"
import { RevealOnScroll, RevealItem } from "@/components/motion/reveal"

/**
 * Honest headline numbers — channels, agents, price, approval model.
 * Counters animate up the first time they scroll into view.
 */
export function StatsBand() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
      <RevealOnScroll
        as="ul"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-border/50 bg-border/40 lg:grid-cols-4"
      >
        {STATS.map((s) => {
          const isPrice = s.suffix === "$"
          return (
            <RevealItem key={s.label}>
              <div className="flex h-full flex-col gap-2 bg-card/60 p-7 backdrop-blur-sm sm:p-8">
                <span className="font-display text-[clamp(2.5rem,6vw,3.5rem)] leading-none tracking-tight text-foreground">
                  {isPrice && <span className="text-primary">$</span>}
                  <Counter value={s.value} />
                  {!isPrice && s.suffix && (
                    <span className="text-primary">{s.suffix}</span>
                  )}
                </span>
                <span className="text-sm leading-snug text-muted-foreground">
                  {s.label}
                </span>
              </div>
            </RevealItem>
          )
        })}
      </RevealOnScroll>
    </section>
  )
}
