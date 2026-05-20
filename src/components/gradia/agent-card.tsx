import Link from "next/link"
import {
  Aperture,
  Brain,
  CalendarDays,
  Check,
  Circle,
  CreditCard,
  Mail,
  MessageSquare,
  Phone,
} from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { Agent } from "@/lib/data/agents"

const ICONS = {
  phone: Phone,
  mail: Mail,
  sms: MessageSquare,
  instagram: Aperture,
  calendar: CalendarDays,
  billing: CreditCard,
  memory: Brain,
} as const

const STATUS_LABEL: Record<Agent["status"], string> = {
  active: "Active",
  needs_setup: "Needs setup",
  off: "Not connected",
}

const STATUS_CLASS: Record<Agent["status"], string> = {
  active:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  needs_setup: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  off: "bg-muted text-muted-foreground",
}

export function AgentCard({ agent }: { agent: Agent }) {
  const Icon = ICONS[agent.iconKey]
  return (
    <Card className="flex h-full flex-col border-border/80">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <Icon className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base font-medium">
              {agent.name}
            </CardTitle>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CLASS[agent.status]}`}
            >
              {STATUS_LABEL[agent.status]}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{agent.oneLiner}</p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <p className="text-sm leading-relaxed">{agent.description}</p>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            What it does for us
          </p>
          <ul className="grid gap-1.5 text-sm">
            {agent.capabilities.map((c, i) => (
              <li key={i} className="flex items-start gap-2">
                <Check
                  className="mt-0.5 size-3.5 shrink-0 text-primary"
                  aria-hidden
                />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
          <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Prerequisites
          </p>
          <ul className="grid gap-1.5 text-sm">
            {agent.prerequisites.map((p, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-2"
              >
                {p.done ? (
                  <Check
                    className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                ) : (
                  <Circle
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                )}
                <span
                  className={
                    p.done
                      ? "text-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {p.label}
                </span>
                {!p.done && p.ctaHref ? (
                  <Link
                    href={p.ctaHref}
                    className={`${buttonVariants({ variant: "outline", size: "xs" })} ml-auto`}
                  >
                    {p.ctaLabel ?? "Set up"}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
