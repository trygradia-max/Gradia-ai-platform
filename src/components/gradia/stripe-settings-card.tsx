"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  ArrowRight,
  Check,
  CreditCard,
  Download,
  Loader2,
  Settings2,
  TriangleAlert,
} from "lucide-react"
import { toast } from "sonner"

import { backfillStripePayments } from "@/app/actions/payments"
import { disconnectStripe } from "@/app/actions/shop"
import { StripeEmbeddedOnboarding } from "@/components/gradia/stripe-embedded-onboarding"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { StatusPill } from "@/components/ui/status-pill"

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
    text: "Stripe connected — we're cleared to send invoices.",
  },
  needs_more: {
    kind: "info",
    text: "Stripe wants a bit more from you — reopen the panel to finish.",
  },
  no_account: {
    kind: "error",
    text: "Lost track of the Stripe account — try connecting again.",
  },
  fetch_failed: {
    kind: "error",
    text: "Couldn't refresh payment status — try again in a minute.",
  },
  account_create_failed: {
    kind: "error",
    text: "Couldn't set up payments — try again in a minute.",
  },
  link_failed: {
    kind: "error",
    text: "Couldn't open the onboarding panel — try again in a moment.",
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
  const [embeddedMode, setEmbeddedMode] = React.useState<
    null | "onboarding" | "management"
  >(null)
  const router = useRouter()
  const reduce = useReducedMotion()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const toastedRef = React.useRef(false)

  React.useEffect(() => {
    if (toastedRef.current || !callbackStatus) return
    toastedRef.current = true
    const msg = CALLBACK_MESSAGES[callbackStatus]
    if (msg) {
      if (msg.kind === "success") toast.success(msg.text)
      else if (msg.kind === "info") toast.message(msg.text)
      else toast.error(msg.text)
    }
    router.replace("/settings#payments", { scroll: false })
  }, [callbackStatus, router])

  async function handleDisconnect() {
    const ok = await confirm({
      title: "Disconnect Stripe?",
      description:
        "You'll need to re-onboard before we can send invoices again.",
      confirmLabel: "Disconnect",
      tone: "destructive",
    })
    if (!ok) return
    setPending("disconnect")
    const result = await disconnectStripe()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setLocalConnected(false)
    setLocalChargesEnabled(false)
    setEmbeddedMode(null)
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

  function handleOnboardingComplete(nextChargesEnabled: boolean) {
    setLocalConnected(true)
    setLocalChargesEnabled(nextChargesEnabled)
    if (nextChargesEnabled) {
      setEmbeddedMode(null)
    }
  }

  return (
    <Card id="payments" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <CreditCard className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">Payments</CardTitle>
          <p className="text-sm text-muted-foreground">
            Charge customers with one voice command. Stripe handles the
            checkout — funds go straight to your bank.
          </p>
        </div>
        {localConnected && localChargesEnabled ? (
          <StatusPill
            tone="good"
            size="default"
            icon={<Check className="size-3" aria-hidden />}
          >
            Connected
          </StatusPill>
        ) : localConnected ? (
          <StatusPill
            tone="warn"
            size="default"
            icon={<TriangleAlert className="size-3" aria-hidden />}
          >
            Needs more info
          </StatusPill>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <AnimatePresence initial={false} mode="wait">
          {embeddedMode ? (
            <motion.div
              key="embedded"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <StripeEmbeddedOnboarding
                mode={embeddedMode}
                onComplete={handleOnboardingComplete}
                onCancel={() => setEmbeddedMode(null)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="summary"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-4"
            >
              {localConnected ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {localChargesEnabled
                      ? "We're cleared to send invoices. Try saying “charge Smith $450 for ceramic” from Whisper."
                      : "Stripe still wants a bit more — reopen the panel to finish (usually identity / bank details)."}
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
                          <Loader2
                            className="size-4 animate-spin"
                            aria-hidden
                          />
                        ) : (
                          <Download className="size-4" aria-hidden />
                        )}
                        Sync history
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleDisconnect}
                      disabled={pending !== null}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {pending === "disconnect" ? (
                        <>
                          <Loader2
                            className="size-4 animate-spin"
                            aria-hidden
                          />
                          Disconnecting
                        </>
                      ) : (
                        "Disconnect"
                      )}
                    </Button>
                    {stripeConfigured ? (
                      <Button
                        type="button"
                        onClick={() =>
                          setEmbeddedMode(
                            localChargesEnabled ? "management" : "onboarding"
                          )
                        }
                        disabled={pending !== null}
                        className="gap-2"
                      >
                        {localChargesEnabled ? (
                          <>
                            <Settings2 className="size-4" aria-hidden />
                            Manage Stripe
                          </>
                        ) : (
                          <>
                            <ArrowRight className="size-4" aria-hidden />
                            Finish onboarding
                          </>
                        )}
                      </Button>
                    ) : null}
                  </div>
                  {localChargesEnabled ? (
                    <p className="text-xs text-muted-foreground">
                      Sync history pulls paid Stripe invoices into our local
                      mirror so the dashboard tiles and Ask Gradia can see
                      what we&apos;ve already collected. Idempotent — safe
                      to run more than once.
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Stripe Connect (Standard accounts). All onboarding —
                    business info, identity, bank details — happens inside
                    Gradia. We never see card numbers or banking secrets;
                    those go straight to Stripe.
                  </p>
                  <div className="flex items-center justify-end">
                    {stripeConfigured ? (
                      <Button
                        type="button"
                        onClick={() => setEmbeddedMode("onboarding")}
                        className="gap-2"
                      >
                        <CreditCard className="size-4" aria-hidden />
                        Connect Stripe
                      </Button>
                    ) : (
                      <Button type="button" disabled>
                        Stripe not configured
                      </Button>
                    )}
                  </div>
                  {!stripeConfigured ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Server is missing <code>STRIPE_SECRET_KEY</code> /{" "}
                      <code>STRIPE_CONNECT_CLIENT_ID</code> /{" "}
                      <code>NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY</code>.
                    </p>
                  ) : null}
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  )
}
