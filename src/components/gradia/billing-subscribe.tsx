"use client"

import * as React from "react"
import { Loader2, Phone } from "lucide-react"
import { toast } from "sonner"

import { toggleVoiceAddon } from "@/app/actions/billing"
import { Button } from "@/components/ui/button"

/**
 * Production checkout stays unavailable until the founder approves a complete
 * tier + seat + usage catalog and the matching Stripe prices are configured.
 */
export function BillingSubscribe() {
  return (
    <div className="grid gap-3" role="status" aria-live="polite">
      <div className="rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Phone className="size-3.5" aria-hidden />
          Pilot activation
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Gradia will confirm your workspace tier, active-user terms, included
          usage, and any pay-as-you-go cap before checkout is enabled.
        </p>
      </div>
      <Button type="button" disabled>
        Contact Gradia to activate
      </Button>
    </div>
  )
}

/** Post-subscription voice add-on toggle (second item on the same
 *  subscription; webhook confirms before features unlock). */
export function VoiceAddonToggle({ active }: { active: boolean }) {
  const [loading, setLoading] = React.useState(false)

  async function handle() {
    if (loading || !active) return
    setLoading(true)
    const result = await toggleVoiceAddon(false)
    setLoading(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      "Voice receptionist removed — it stops at the next call; your number stays reserved for 30 days."
    )
    window.location.reload()
  }

  return (
    <Button
      type="button"
      variant={active ? "outline" : "default"}
      onClick={handle}
      disabled={loading || !active}
      className="gap-2"
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <Phone className="size-4" aria-hidden />
      )}
      {active ? "Remove voice receptionist" : "Contact Gradia to add voice"}
    </Button>
  )
}
