"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion"

import { AGENTS, type AgentDef } from "@/lib/site"
import { cn } from "@/lib/utils"
import { AGENT_ICON, AGENT_TILE } from "@/components/icons"

function AgentPanel({ agent }: { agent: AgentDef }) {
  const Icon = AGENT_ICON[agent.iconKey]
  return (
    <article className="group relative flex h-full w-[85vw] max-w-[460px] shrink-0 flex-col overflow-hidden rounded-3xl border border-border/60 bg-card/60 backdrop-blur-sm transition-colors duration-300 hover:border-border lg:w-[440px]">
      {agent.image ? (
        <div className="relative aspect-[16/10] overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={agent.image}
            alt=""
            className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-105"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-card via-card/30 to-transparent" />
        </div>
      ) : (
        // No photo → a branded graphic header so every card carries weight.
        <div
          className={cn(
            "relative flex aspect-[16/10] items-center justify-center overflow-hidden",
            AGENT_TILE[agent.iconKey]
          )}
        >
          <Icon
            className="size-24 opacity-20 transition-transform duration-700 ease-out group-hover:scale-110"
            aria-hidden
          />
          <span
            aria-hidden
            className="absolute -bottom-6 right-5 font-display text-[5.5rem] leading-none tracking-tight text-foreground/[0.04]"
          >
            {agent.name.split(" ")[0]}
          </span>
          <div className="absolute inset-0 bg-gradient-to-t from-card via-card/40 to-transparent" />
        </div>
      )}

      <div className="flex flex-1 flex-col gap-4 p-7">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-11 items-center justify-center rounded-xl ring-1",
              AGENT_TILE[agent.iconKey]
            )}
          >
            <Icon className="size-5" aria-hidden />
          </div>
          <span className="rounded-full border border-border/60 bg-background/60 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
            {agent.stack}
          </span>
        </div>

        <div className="space-y-2">
          <h3 className="font-display text-2xl leading-tight tracking-tight text-foreground">
            {agent.name}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {agent.oneLiner}
          </p>
        </div>

        <ul className="mt-auto space-y-2 pt-2">
          {agent.capabilities.slice(0, 3).map((cap) => (
            <li
              key={cap}
              className="flex items-start gap-2.5 text-sm text-foreground/80"
            >
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/70" />
              {cap}
            </li>
          ))}
        </ul>

        <Link
          href={`/docs/agents/${agent.slug}`}
          data-cursor="cta"
          className="inline-flex items-center gap-1 pt-1 text-sm font-medium text-primary transition-colors hover:text-foreground"
        >
          Read the docs
          <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </article>
  )
}

export function AgentsShowcase() {
  const reduce = useReducedMotion()
  const sectionRef = React.useRef<HTMLDivElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [distance, setDistance] = React.useState(0)

  React.useLayoutEffect(() => {
    if (reduce) return
    const measure = () => {
      const track = trackRef.current
      if (!track) return
      setDistance(Math.max(0, track.scrollWidth - window.innerWidth))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [reduce])

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  })
  // Travel the track from the left padding to fully revealing the last card.
  const x = useTransform(scrollYProgress, [0, 1], [0, -distance])
  const progress = useTransform(scrollYProgress, [0, 1], ["0%", "100%"])

  // Reduced motion: a plain, swipeable horizontal scroller. No pinning.
  if (reduce) {
    return (
      <section id="agents" className="scroll-mt-24 py-24 sm:py-32">
        <Header />
        <div className="mt-12 flex gap-5 overflow-x-auto px-5 pb-4 sm:px-8">
          {AGENTS.map((a) => (
            <AgentPanel key={a.slug} agent={a} />
          ))}
        </div>
      </section>
    )
  }

  return (
    <section
      id="agents"
      ref={sectionRef}
      className="relative scroll-mt-24"
      style={{ height: `calc(100vh + ${distance}px)` }}
    >
      <div className="sticky top-0 flex h-screen flex-col justify-center overflow-hidden">
        <div className="px-5 sm:px-8">
          <Header />
        </div>

        <motion.div
          ref={trackRef}
          style={{ x }}
          className="mt-10 flex gap-5 px-5 sm:mt-12 sm:px-8"
        >
          {AGENTS.map((a) => (
            <AgentPanel key={a.slug} agent={a} />
          ))}
          {/* Trailing spacer so the last card clears the right edge. */}
          <div aria-hidden className="w-[10vw] shrink-0" />
        </motion.div>

        {/* Horizontal progress rail */}
        <div className="mx-auto mt-10 h-px w-[min(90%,420px)] overflow-hidden rounded-full bg-border">
          <motion.div className="h-full bg-primary" style={{ width: progress }} />
        </div>
      </div>
    </section>
  )
}

function Header() {
  return (
    <div className="mx-auto max-w-6xl">
      <p className="label-eyebrow flex items-center gap-2 text-muted-foreground/70">
        <span className="h-px w-6 bg-gradient-to-r from-transparent to-primary/50" />
        Seven agents, one brain
      </p>
      <h2 className="mt-3 max-w-3xl font-display text-[clamp(2.1rem,5.5vw,3.75rem)] leading-[1.02] tracking-[-0.03em] text-foreground">
        Cover every channel.{" "}
        <span className="italic text-primary">Drop nothing.</span>
      </h2>
    </div>
  )
}
