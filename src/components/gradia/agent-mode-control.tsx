"use client"

import * as React from "react"
import { ShieldCheck, Zap } from "lucide-react"
import { toast } from "sonner"

import { setAgentMode } from "@/app/actions/autonomy"
import type { AutonomyMode } from "@/lib/autonomy"
import { cn } from "@/lib/utils"

/**
 * Per-agent trust dial (BUILD_REFERENCE §5). Suggest (we draft, you approve) vs
 * Auto (we act, then log). Autonomous can be gated until prerequisites are met.
 */
export function AgentModeControl({
  agentKey,
  initialMode,
  canGoAutonomous = true,
  disabledReason,
  className,
}: {
  agentKey: string
  initialMode: AutonomyMode
  canGoAutonomous?: boolean
  disabledReason?: string
  className?: string
}) {
  const [mode, setMode] = React.useState<AutonomyMode>(initialMode)
  const [pending, startTransition] = React.useTransition()

  function choose(next: AutonomyMode) {
    if (next === mode || pending) return
    if (next === "autonomous" && !canGoAutonomous) {
      toast.message(
        disabledReason ?? "Finish setup before this agent can act on its own."
      )
      return
    }
    const prev = mode
    setMode(next)
    startTransition(async () => {
      const result = await setAgentMode(agentKey, next)
      if (!result.ok) {
        setMode(prev)
        toast.error(result.error)
        return
      }
      toast.success(
        next === "autonomous"
          ? "On autopilot — we'll act and log it."
          : "Back to suggest — we'll ask first."
      )
    })
  }

  const options = [
    { m: "suggest" as const, label: "Suggest", Icon: ShieldCheck },
    { m: "autonomous" as const, label: "Auto", Icon: Zap },
  ]

  return (
    <div
      role="radiogroup"
      aria-label="Agent mode"
      className={cn(
        "inline-flex items-center rounded-lg border border-border/60 p-0.5",
        className
      )}
    >
      {options.map(({ m, label, Icon }) => {
        const active = mode === m
        const blocked = m === "autonomous" && !canGoAutonomous
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={pending}
            title={blocked ? (disabledReason ?? "Finish setup first") : undefined}
            onClick={() => choose(m)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
              blocked && !active && "opacity-50"
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        )
      })}
    </div>
  )
}
