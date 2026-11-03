"use client"

import * as React from "react"
import { Loader2, Phone } from "lucide-react"
import { toast } from "sonner"

import { toggleVoiceAddon } from "@/app/actions/billing"
import { Button } from "@/components/ui/button"

/**
 * The Founder Pilot terms are approved. Production checkout stays unavailable
 * until settlement, Stripe provisioning and release acceptance are complete.
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
          Founder Pilot is $199/month with 3 operator seats, 2 active agents,
          100 digital outcomes, 100 voice minutes and a $100 default overage cap.
          Checkout opens after billing reconciliation passes release acceptance.
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
