"use client"

import * as React from "react"
import {
  Check,
  CreditCard,
  Download,
  Loader2,
  Plug,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

import { backfillStripePayments } from "@/app/actions/payments"
import { disconnectStripe } from "@/app/actions/shop"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

type CallbackStatus =
  | "ok"
  | "needs_more"
  | "no_account"
  | "fetch_failed"
  | "account_create_failed"
  | "link_failed"

const CALLBACK_MESSAGES: Record<
  CallbackStatus,
  { kind: "success" | "error" | "info"; text: string }
> = {
  ok: {
    kind: "success",
    text: "Stripe connected. Charges enabled — we're ready to send invoices.",
  },
  needs_more: {
    kind: "info",
    text: "Stripe wants a bit more info before charges can run — open Connect again to finish.",
  },
  no_account: {
    kind: "error",
    text: "Lost track of the Stripe account — try connecting again.",
  },
  fetch_failed: {
    kind: "error",
    text: "Couldn't refresh Stripe status — check the server logs.",
  },
  account_create_failed: {
    kind: "error",
    text: "Couldn't create the Stripe account — check the server logs.",
  },
  link_failed: {
    kind: "error",
    text: "Couldn't open the onboarding link — try again in a moment.",
  },
}

export function StripeSettingsCard({
  connected,
  chargesEnabled,
  stripeConfigured,
  callbackStatus,
}: {
  connected: boolean
  chargesEnabled: boolean
  stripeConfigured: boolean
  callbackStatus: CallbackStatus | null
}) {
  const [pending, setPending] = React.useState<
    null | "disconnect" | "backfill"
  >(null)
  const [localConnected, setLocalConnected] = React.useState(connected)
  const [localChargesEnabled, setLocalChargesEnabled] =
    React.useState(chargesEnabled)
  const toastedRef = React.useRef(false)

  React.useEffect(() => {
    if (toastedRef.current || !callbackStatus) return
    toastedRef.current = true
    const msg = CALLBACK_MESSAGES[callbackStatus]
    if (!msg) return
    if (msg.kind === "success") toast.success(msg.text)
    else if (msg.kind === "info") toast.message(msg.text)
    else toast.error(msg.text)
  }, [callbackStatus])

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect Stripe? You'll need to re-onboard to send invoices again."
      )
    )
      return
    setPending("disconnect")
    const result = await disconnectStripe()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setLocalConnected(false)
    setLocalChargesEnabled(false)
    toast.success("Stripe disconnected.")
  }

  async function handleBackfill() {
    setPending("backfill")
    const result = await backfillStripePayments()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (result.processed === 0) {
      toast.message("Nothing new to sync — we're already caught up.")
    } else {
      toast.success(
        `Synced ${result.processed} paid invoice${result.processed === 1 ? "" : "s"} from Stripe.`
      )
    }
  }

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <CreditCard className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">Payments</CardTitle>
          <p className="text-sm text-muted-foreground">
            Charge customers with one voice command. Stripe handles the
            checkout — funds go straight to our bank.
          </p>
        </div>
        {localConnected && localChargesEnabled ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-3" aria-hidden />
            Connected
          </span>
        ) : localConnected ? (
          <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-3" aria-hidden />
            Needs more info
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {localConnected ? (
          <>
            <p className="text-sm text-muted-foreground">
              {localChargesEnabled
                ? "We're cleared to send invoices on our connected account. Try saying \"charge Smith $450 for ceramic\" from Whisper."
                : "Stripe needs a bit more from us — re-open onboarding to finish (usually identity / bank details)."}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {localChargesEnabled ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleBackfill}
                  disabled={pending !== null}
                  className="gap-2"
                >
                  {pending === "backfill" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="size-4" aria-hidden />
                  )}
                  Sync history
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={handleDisconnect}
                disabled={pending !== null}
              >
                {pending === "disconnect" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Disconnecting
                  </>
                ) : (
                  "Disconnect"
                )}
              </Button>
              {!localChargesEnabled && stripeConfigured ? (
                <a
                  href="/api/stripe/connect/start"
                  className={buttonVariants({ variant: "default" })}
                >
                  <Plug className="size-4" aria-hidden />
                  Continue onboarding
                </a>
              ) : null}
            </div>
            {localChargesEnabled ? (
              <p className="text-xs text-muted-foreground">
                Sync history pulls paid Stripe invoices into our local
                mirror so our dashboard tiles and BI chat can see what
                we&apos;ve already collected. Idempotent — safe to run
                more than once.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Stripe Connect (Standard accounts). We never see or store a
              raw secret key — Stripe gives us a connected-account ID, we
              charge on our behalf with that.
            </p>
            <div className="flex items-center justify-end">
              {stripeConfigured ? (
                <a
                  href="/api/stripe/connect/start"
                  className={buttonVariants({ variant: "default" })}
                >
                  <Plug className="size-4" aria-hidden />
                  Connect Stripe
                </a>
              ) : (
                <Button type="button" disabled>
                  Stripe not configured
                </Button>
              )}
            </div>
            {!stripeConfigured ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Server is missing <code>STRIPE_SECRET_KEY</code> /{" "}
                <code>STRIPE_CONNECT_CLIENT_ID</code>.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
