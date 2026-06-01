"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { startSubscriptionCheckout } from "@/app/actions/billing"
import { Button } from "@/components/ui/button"

export function BillingSubscribe() {
  const [loading, setLoading] = React.useState(false)

  async function handle() {
    if (loading) return
    setLoading(true)
    const result = await startSubscriptionCheckout()
    if (!result.ok) {
      setLoading(false)
      toast.error(result.error)
      return
    }
    window.location.href = result.url
  }

  return (
    <Button onClick={handle} disabled={loading} className="gap-2">
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      Subscribe — $20/month
    </Button>
  )
}
