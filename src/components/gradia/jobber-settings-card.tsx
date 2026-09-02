"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Briefcase, Check, Loader2, Plug } from "lucide-react"
import { toast } from "sonner"

import { disconnectJobber } from "@/app/actions/shop"
import { HelpTip } from "@/components/gradia/help-tip"
import { Button, buttonVariants } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { StatusPill } from "@/components/ui/status-pill"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { STRINGS } from "@/lib/strings"

export type JobberCallbackStatus =
  | "ok"
  | "denied"
  | "missing_params"
  | "state_mismatch"
  | "token_exchange_failed"
  | "account_fetch_failed"
  | "save_failed"
  | null

export function JobberSettingsCard({
  initialAccountName,
  jobberConfigured,
  callbackStatus,
}: {
  initialAccountName: string | null
  jobberConfigured: boolean
  callbackStatus?: JobberCallbackStatus
}) {
  const router = useRouter()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [accountName, setAccountName] = React.useState(initialAccountName)
  const [pending, setPending] = React.useState<null | "disconnect">(null)
  const toastedRef = React.useRef(false)
  const isConnected = Boolean(accountName)

  // Surface OAuth callback outcomes as toasts. Ref-guarded so a
  // re-render doesn't fire it twice; URL stripped after so reload
  // doesn't either.
  React.useEffect(() => {
    if (toastedRef.current || !callbackStatus) return
    toastedRef.current = true
    switch (callbackStatus) {
      case "ok":
        toast.success("Jobber connected.")
        break
      case "denied":
        toast.error("Permission was denied on Jobber.")
        break
      case "missing_params":
      case "state_mismatch":
        toast.error("Connection token mismatch — try again.")
        break
      case "token_exchange_failed":
        toast.error("Jobber rejected the auth code — try again.")
        break
      case "account_fetch_failed":
        toast.error(
          "Connected, but couldn't read account info. Try reconnecting."
        )
        break
      case "save_failed":
        toast.error("Couldn't save the connection. Try again.")
        break
    }
    router.replace("/settings#jobber", { scroll: false })
  }, [callbackStatus, router])

  async function handleDisconnect() {
    const ok = await confirm({
      title: "Disconnect Jobber?",
      description:
        "Approved bookings will stop pushing to Jobber until you reconnect.",
      confirmLabel: "Disconnect",
      tone: "destructive",
    })
    if (!ok) return
    setPending("disconnect")
    const result = await disconnectJobber()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setAccountName(null)
    toast.success("Jobber disconnected.")
  }

  return (
    <Card id="jobber" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Briefcase className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="flex items-center gap-1.5 text-base font-medium">
            Jobber
            <HelpTip label="Jobber" text={STRINGS.help.settings.crm} />
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Push approved leads and bookings into Jobber so our existing
            CRM stays the system of record. We sit on top, not in place.
          </p>
        </div>
        {isConnected ? (
          <StatusPill
            tone="good"
            size="default"
            icon={<Check className="size-3" aria-hidden />}
          >
            Connected
          </StatusPill>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {isConnected ? (
          <>
            <p className="text-sm text-muted-foreground">
              Connected to <span className="font-medium text-foreground">{accountName}</span>.
              Approved bookings will create a Jobber client + request the
              moment they&apos;re approved.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleDisconnect}
                disabled={pending !== null}
                className="h-11 sm:h-9"
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
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              OAuth via the Jobber developer console. We never see your
              Jobber password — Jobber gives us a scoped token we store
              encrypted at rest.
            </p>
            <div className="flex items-center justify-end">
              {jobberConfigured ? (
                <a
                  href="/api/jobber/auth/start"
                  className={`${buttonVariants({ variant: "default" })} h-11 sm:h-9`}
                >
                  <Plug className="size-4" aria-hidden />
                  Connect Jobber
                </a>
              ) : (
                <Button type="button" disabled className="h-11 sm:h-9">
                  {STRINGS.connections.notAvailable}
                </Button>
              )}
            </div>
            {!jobberConfigured ? (
              // Honest NOT AVAILABLE (UX-001): owner terms, no env var names.
              <p className="text-xs text-muted-foreground">
                {STRINGS.connections.notAvailableReason.crm}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
