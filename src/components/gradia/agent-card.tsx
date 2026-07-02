import Link from "next/link"
import {
  Brain,
  CalendarDays,
  Check,
  Circle,
  CreditCard,
  Mail,
  MessageSquare,
  Phone,
  type LucideIcon,
} from "lucide-react"

import { MotionCard } from "@/components/gradia/motion/motion-card"
import { PulseDot } from "@/components/gradia/motion/pulse-dot"
import { buttonVariants } from "@/components/ui/button"
import { StatusPill, type StatusPillTone } from "@/components/ui/status-pill"
import type { Agent } from "@/lib/data/agents"
import { cn } from "@/lib/utils"

const ICONS: Record<Agent["iconKey"], LucideIcon> = {
  phone: Phone,
  mail: Mail,
  sms: MessageSquare,
  calendar: CalendarDays,
  billing: CreditCard,
  memory: Brain,
}

const STATUS_LABEL: Record<Agent["status"], string> = {
  active: "Live",
  needs_setup: "Needs info",
  off: "Off",
}

const STATUS_TONE: Record<Agent["status"], StatusPillTone> = {
  active: "good",
  needs_setup: "warn",
  off: "muted",
}

const ICON_TILE: Record<Agent["status"], string> = {
  active:
    "bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-400",
  needs_setup:
    "bg-amber-500/12 text-amber-600 ring-amber-500/25 dark:text-amber-400",
  off: "bg-muted text-muted-foreground ring-border/60",
}

const RAIL: Record<Agent["status"], string> = {
  active:
    "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-[''] before:bg-gradient-to-b before:from-emerald-400/40 before:via-emerald-400/15 before:to-transparent",
  needs_setup:
    "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-[''] before:bg-gradient-to-b before:from-amber-400/40 before:via-amber-400/15 before:to-transparent",
  off: "",
}

export function AgentCard({ agent }: { agent: Agent }) {
  const Icon = ICONS[agent.iconKey]
  const isLive = agent.status === "active"
  return (
    <MotionCard
      interactive

      className={cn(
        "relative flex h-full flex-col overflow-hidden p-5 sm:p-6",
        RAIL[agent.status]
      )}
    >
      <header className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
            ICON_TILE[agent.status]
          )}
        >
          <Icon className="size-[18px]" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="flex items-center gap-1.5 font-display text-lg leading-tight tracking-tight text-foreground">
              <span>{agent.name}</span>
              {isLive ? (
                <PulseDot tone="good" size={5} className="shrink-0" />
              ) : null}
            </h3>
            <StatusPill tone={STATUS_TONE[agent.status]}>
              {STATUS_LABEL[agent.status]}
            </StatusPill>
          </div>
          <p className="text-sm text-muted-foreground">{agent.oneLiner}</p>
        </div>
      </header>

      <div className="mt-5 flex flex-1 flex-col gap-5">
        <p className="text-sm leading-relaxed text-foreground/90">
          {agent.description}
        </p>

        <div className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">
            What it does for us
          </p>
          <ul className="grid gap-1.5 text-sm">
            {agent.capabilities.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <Check
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    isLive ? "text-emerald-500" : "text-primary"
                  )}
                  aria-hidden
                />
                <span className="text-foreground/90">{c}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3">
          <p className="label-eyebrow mb-2 text-muted-foreground/70">
            Prerequisites
          </p>
          <ul className="grid gap-2 text-sm">
            {agent.prerequisites.map((p, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-2"
              >
                {p.done ? (
                  <Check
                    className="size-3.5 shrink-0 text-emerald-500 dark:text-emerald-400"
                    aria-hidden
                  />
                ) : (
                  <Circle
                    className="size-3.5 shrink-0 text-muted-foreground/70"
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    p.done ? "text-foreground/90" : "text-muted-foreground"
                  )}
                >
                  {p.label}
                </span>
                {!p.done && p.ctaHref ? (
                  <Link
                    href={p.ctaHref}
                    className={cn(
                      buttonVariants({ variant: "outline", size: "xs" }),
                      "ml-auto"
                    )}
                  >
                    {p.ctaLabel ?? "Set up"}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </MotionCard>
  )
}
