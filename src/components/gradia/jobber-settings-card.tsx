"use client"

import * as React from "react"
import { Briefcase, Check, Loader2, Plug } from "lucide-react"
import { toast } from "sonner"

import { disconnectJobber } from "@/app/actions/shop"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

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
  const [accountName, setAccountName] = React.useState(initialAccountName)
  const [pending, setPending] = React.useState<null | "disconnect">(null)
  const isConnected = Boolean(accountName)

  // Surface OAuth callback outcomes as toasts.
  React.useEffect(() => {
    if (!callbackStatus) return
    switch (callbackStatus) {
      case "ok":
        toast.success("Jobber connected.")
        return
      case "denied":
        toast.error("Permission was denied on Jobber.")
        return
      case "missing_params":
      case "state_mismatch":
        toast.error("Connection token mismatch — try again.")
        return
      case "token_exchange_failed":
        toast.error("Jobber rejected the auth code — try again.")
        return
      case "account_fetch_failed":
        toast.error(
          "Connected, but couldn't read account info. Try reconnecting."
        )
        return
      case "save_failed":
        toast.error("Couldn't save the connection. Try again.")
        return
    }
  }, [callbackStatus])

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect Jobber? Approved bookings will stop pushing to it until reconnected."
      )
    )
      return
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
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Briefcase className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">Jobber</CardTitle>
          <p className="text-sm text-muted-foreground">
            Push approved leads and bookings into Jobber so our existing
            CRM stays the system of record. We sit on top, not in place.
          </p>
        </div>
        {isConnected ? (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-3" aria-hidden />
            Connected
          </span>
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
                  Jobber not configured
                </Button>
              )}
            </div>
            {!jobberConfigured ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Server is missing <code>JOBBER_CLIENT_ID</code> /{" "}
                <code>JOBBER_CLIENT_SECRET</code>.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
