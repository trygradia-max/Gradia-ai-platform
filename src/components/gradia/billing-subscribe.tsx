"use client"

import * as React from "react"
import { Loader2, Phone } from "lucide-react"
import { toast } from "sonner"

import {
  startSubscriptionCheckout,
  toggleVoiceAddon,
} from "@/app/actions/billing"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

/**
 * Two SKUs, priced together everywhere — never a checkout surprise
 * (GRADIA_PRICING.md copy rule): "From $20/mo; voice receptionist +
 * business number +$29."
 */
export function BillingSubscribe() {
  const [loading, setLoading] = React.useState(false)
  const [withVoice, setWithVoice] = React.useState(false)

  async function handle() {
    if (loading) return
    setLoading(true)
    const result = await startSubscriptionCheckout({
      includeVoiceAddon: withVoice,
    })
    if (!result.ok) {
      setLoading(false)
      toast.error(result.error)
      return
    }
    window.location.href = result.url
  }

  return (
    <div className="grid gap-3">
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3">
        <input
          type="checkbox"
          checked={withVoice}
          onChange={(e) => setWithVoice(e.target.checked)}
          className="mt-1 size-4 accent-[var(--primary)]"
        />
        <span className="space-y-0.5">
          <Label className="flex items-center gap-1.5 text-sm">
            <Phone className="size-3.5" aria-hidden />
            Voice Receptionist — +$29/month
          </Label>
          <span className="block text-xs text-muted-foreground">
            Answers your calls, quotes, and takes bookings. Business number
            and ~20 answered calls a month included. Standalone AI
            receptionists run $100–300/mo elsewhere.
          </span>
        </span>
      </label>
      <Button onClick={handle} disabled={loading} className="gap-2">
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Subscribe — ${withVoice ? "49" : "20"}/month
      </Button>
    </div>
  )
}

/** Post-subscription voice add-on toggle (second item on the same
 *  subscription; webhook confirms before features unlock). */
export function VoiceAddonToggle({ active }: { active: boolean }) {
  const [loading, setLoading] = React.useState(false)

  async function handle() {
    if (loading) return
    setLoading(true)
    const result = await toggleVoiceAddon(!active)
    setLoading(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      active
        ? "Voice receptionist removed — it stops at the next call; your number stays reserved for 30 days."
        : "Voice receptionist added — head to Settings → Voice to set it up."
    )
    window.location.reload()
  }

  return (
    <Button
      type="button"
      variant={active ? "outline" : "default"}
      onClick={handle}
      disabled={loading}
      className="gap-2"
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Phone className="size-4" aria-hidden />
      )}
      {active ? "Remove voice receptionist" : "Add voice receptionist — +$29/mo"}
    </Button>
  )
}
