"use client"

import * as React from "react"
import { Loader2, MessageSquareText, PhoneCall } from "lucide-react"
import { toast } from "sonner"

import { startPackCheckout, type UsageState } from "@/app/actions/billing"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function Bar({ used, total, warn }: { used: number; total: number; warn: boolean }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
      <div
        className={cn(
          "h-full rounded-full transition-all",
          warn ? "bg-amber-500" : "bg-primary"
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/**
 * The two meters, in human units (copy rule: "~200 texts", never bare
 * credit numbers as the headline). They never cross — voice can't drain
 * message credits. At 80% the pack offer appears with ROI framing.
 */
export function UsageMeters({ usage }: { usage: UsageState }) {
  const [buying, setBuying] = React.useState<null | "credit" | "minute">(null)

  async function buyPack(pack: "credit" | "minute") {
    if (buying) return
    setBuying(pack)
    const result = await startPackCheckout(pack)
    setBuying(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    window.location.href = result.url
  }

  return (
    <div className="space-y-4">
      {/* Messages meter */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <MessageSquareText className="size-4 text-muted-foreground" aria-hidden />
            Messages
          </p>
          <p className="text-sm text-foreground">
            ~{usage.human.texts} texts left
            <span className="ml-1.5 text-xs text-muted-foreground">
              ({usage.credits.remaining} of {usage.credits.allowance} credits)
            </span>
          </p>
        </div>
        <Bar
          used={usage.credits.used}
          total={usage.credits.allowance}
          warn={usage.credits.warn}
        />
        {usage.credits.warn ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2">
            <p className="text-xs text-foreground">
              {usage.credits.over
                ? "Out of credits — sending is paused until you top up or the month resets."
                : "Running low — keep the follow-ups going?"}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={buying !== null}
              onClick={() => buyPack("credit")}
              className="gap-1.5"
            >
              {buying === "credit" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              Add 950 credits — $10
            </Button>
          </div>
        ) : null}
      </div>

      {/* Minutes meter — only with the voice add-on */}
      {usage.voiceAddon ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <PhoneCall className="size-4 text-muted-foreground" aria-hidden />
              Voice minutes
            </p>
            <p className="text-sm text-foreground">
              ~{usage.human.calls ?? 0} answered calls left
              <span className="ml-1.5 text-xs text-muted-foreground">
                ({usage.minutes.remaining} of {usage.minutes.allowance} min)
              </span>
            </p>
          </div>
          <Bar
            used={usage.minutes.used}
            total={usage.minutes.allowance}
            warn={usage.minutes.warn}
          />
          {usage.minutes.warn ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2">
              <p className="text-xs text-foreground">
                {usage.minutes.over
                  ? "Out of minutes — the receptionist takes messages until you top up or the month resets."
                  : "Call volume's up — don't let the receptionist go quiet."}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={buying !== null}
                onClick={() => buyPack("minute")}
                className="gap-1.5"
              >
                {buying === "minute" ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : null}
                Add 40 minutes — $10
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
