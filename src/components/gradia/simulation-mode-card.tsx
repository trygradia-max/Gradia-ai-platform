"use client"

import * as React from "react"
import { Check, FlaskConical, Radio } from "lucide-react"
import { toast } from "sonner"

import { setSimulationMode } from "@/app/actions/shop"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const OPTIONS: {
  value: boolean
  label: string
  hint: string
  icon: typeof Radio
}[] = [
  {
    value: false,
    label: "Live",
    hint: "We stage real actions to your Approvals inbox as normal.",
    icon: Radio,
  },
  {
    value: true,
    label: "Shadow Mode",
    hint: "We watch and draft, but queue nothing — safe to try while you set up.",
    icon: FlaskConical,
  },
]

export function SimulationModeCard({
  initialEnabled,
}: {
  initialEnabled: boolean
}) {
  const [enabled, setEnabled] = React.useState<boolean>(initialEnabled)
  const [pending, startTransition] = React.useTransition()

  function choose(next: boolean) {
    if (next === enabled || pending) return
    const prev = enabled
    setEnabled(next)
    startTransition(async () => {
      const result = await setSimulationMode(next)
      if (!result.ok) {
        setEnabled(prev)
        toast.error(result.error)
        return
      }
      toast.success(
        next
          ? "Shadow Mode on — nothing will be queued until you go live."
          : "Live — we'll stage actions for your approval again."
      )
    })
  }

  return (
    <Card className="border-border/60">
      <CardHeader className="space-y-1">
        <CardTitle className="font-display text-lg tracking-tight">
          Shadow Mode
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          A safe switch for setup. In Shadow Mode we still read and draft, but we
          never queue anything for real send.
        </p>
      </CardHeader>
      <CardContent>
        <div
          className="grid gap-3 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Shadow Mode"
        >
          {OPTIONS.map((opt) => {
            const active = enabled === opt.value
            const Icon = opt.icon
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={pending}
                onClick={() => choose(opt.value)}
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
