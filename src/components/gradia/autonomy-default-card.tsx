"use client"

import * as React from "react"
import { Check, ShieldCheck, Zap } from "lucide-react"
import { toast } from "sonner"

import { setAutonomyDefault } from "@/app/actions/autonomy"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { AutonomyMode } from "@/lib/autonomy"
import { cn } from "@/lib/utils"

const OPTIONS: {
  mode: AutonomyMode
  label: string
  hint: string
  icon: typeof ShieldCheck
}[] = [
  {
    mode: "suggest",
    label: "Suggest first",
    hint: "We draft, you approve, then it sends. Recommended.",
    icon: ShieldCheck,
  },
  {
    mode: "autonomous",
    label: "Act autonomously",
    hint: "We handle it and log what we did. Money + calendar still ask first.",
    icon: Zap,
  },
]

export function AutonomyDefaultCard({
  initialMode,
}: {
  initialMode: AutonomyMode
}) {
  const [mode, setMode] = React.useState<AutonomyMode>(initialMode)
  const [pending, startTransition] = React.useTransition()

  function choose(next: AutonomyMode) {
    if (next === mode || pending) return
    const prev = mode
    setMode(next)
    startTransition(async () => {
      const result = await setAutonomyDefault(next)
      if (!result.ok) {
        setMode(prev)
        toast.error(result.error)
        return
      }
      toast.success(
        next === "autonomous"
          ? "New agents will act on their own."
          : "New agents will check with us first."
      )
    })
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="space-y-1">
        <CardTitle className="font-display text-lg tracking-tight">
          How should we act?
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          The default new agents inherit. You can still set any single agent
          differently on the Agents page.
        </p>
      </CardHeader>
      <CardContent>
        <div
          className="grid gap-3 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Default autonomy"
        >
          {OPTIONS.map((opt) => {
            const active = mode === opt.mode
            const Icon = opt.icon
            return (
              <button
                key={opt.mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={pending}
                onClick={() => choose(opt.mode)}
                className={cn(
                  "flex cursor-pointer flex-col gap-2 rounded-xl border p-4 text-left transition-colors",
                  active
                    ? "border-primary/60 bg-primary/8 ring-1 ring-primary/30"
                    : "border-border/60 hover:border-border hover:bg-muted/40"
                )}
              >
                <div className="flex items-center justify-between">
                  <Icon
                    className={cn(
                      "size-5",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                    aria-hidden
                  />
                  {active ? (
                    <Check className="size-4 text-primary" aria-hidden />
                  ) : null}
                </div>
                <div>
                  <p className="font-medium text-foreground">{opt.label}</p>
                  <p className="text-sm text-muted-foreground">{opt.hint}</p>
                </div>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
