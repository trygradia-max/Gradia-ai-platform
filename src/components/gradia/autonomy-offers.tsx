"use client"

import * as React from "react"
import { Sparkles } from "lucide-react"

import { setAgentMode } from "@/app/actions/autonomy"
import { Button } from "@/components/ui/button"
import type { AutonomyRecommendation } from "@/lib/trust"

/**
 * Earned-autonomy offers (L6). Surfaces "you've approved X unedited N× — let it
 * run on its own?" for action types that cleared the trust threshold. Flipping
 * one sets the per-action autonomy override; the owner can switch back anytime,
 * and money/calendar always ask first regardless.
 */
export function AutonomyOffers({
  recommendations,
}: {
  recommendations: AutonomyRecommendation[]
}) {
  const [items, setItems] = React.useState(recommendations)
  const [pending, startTransition] = React.useTransition()

  if (items.length === 0) return null

  return (
    <div className="space-y-3">
      {items.map((rec) => (
        <div
          key={rec.actionType}
          className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-4"
        >
          <div className="min-w-0">
            <p className="text-sm text-foreground">
              You&rsquo;ve approved <span className="font-medium">{rec.label}</span>{" "}
              unedited {rec.decisions}× ({Math.round(rec.uneditedRate * 100)}%).
            </p>
            <p className="text-xs text-muted-foreground">
              Want us to send them on our own from now on? You can switch back
              any time — money &amp; calendar always ask first.
            </p>
          </div>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await setAgentMode(rec.actionType, "autonomous")
                if (res.ok) {
                  setItems((cur) =>
                    cur.filter((x) => x.actionType !== rec.actionType)
                  )
                }
              })
            }
          >
            <Sparkles className="mr-1.5 size-4" aria-hidden />
            Turn on autopilot
          </Button>
        </div>
      ))}
    </div>
  )
}
