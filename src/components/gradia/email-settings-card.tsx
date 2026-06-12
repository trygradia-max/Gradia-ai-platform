"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, Loader2, Mail, Plug } from "lucide-react"
import { toast } from "sonner"

import { disconnectEmail } from "@/app/actions/shop"
import { Button, buttonVariants } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

type CallbackStatus =
  | "ok"
  | "denied"
  | "missing_params"
  | "state_mismatch"
  | "token_exchange_failed"
  | "account_fetch_failed"
  | "subscription_failed"
  | "save_failed"

const CALLBACK_MESSAGES: Record<CallbackStatus, { kind: "success" | "error"; text: string }> = {
  ok: { kind: "success", text: "Email connected. New inquiries will land in approvals." },
  denied: { kind: "error", text: "We didn't get permission — try again when you're ready." },
  missing_params: { kind: "error", text: "OAuth response was incomplete — please try again." },
  state_mismatch: { kind: "error", text: "Security check failed — please try again." },
  token_exchange_failed: { kind: "error", text: "Couldn't finish connecting Gmail — try again in a minute." },
  account_fetch_failed: { kind: "error", text: "Connected but couldn't read your account. Try disconnecting and again." },
  subscription_failed: { kind: "error", text: "Connected but couldn't subscribe to new mail. Try disconnecting and again." },
  save_failed: { kind: "error", text: "Couldn't save the connection. Check the server logs." },
}

export function EmailSettingsCard({
  initialAccountEmail,
  aurinkoConfigured,
  callbackStatus,
}: {
  initialAccountEmail: string | null
  aurinkoConfigured: boolean
  callbackStatus: CallbackStatus | null
}) {
  const router = useRouter()
  const [accountEmail, setAccountEmail] = React.useState(initialAccountEmail)
  const [pending, setPending] = React.useState(false)
  const toastedRef = React.useRef(false)

  React.useEffect(() => {
    if (toastedRef.current || !callbackStatus) return
    toastedRef.current = true
    const msg = CALLBACK_MESSAGES[callbackStatus]
    if (msg) {
      if (msg.kind === "success") toast.success(msg.text)
      else toast.error(msg.text)
    }
    // Strip the ?email=... param so a reload doesn't re-fire the toast.
    router.replace("/settings#email", { scroll: false })
  }, [callbackStatus, router])

  const isConnected = Boolean(accountEmail)

  async function handleDisconnect() {
    setPending(true)
    const result = await disconnectEmail()
    setPending(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setAccountEmail(null)
    toast.success("Email disconnected.")
  }

  return (
    <Card id="email" className="scroll-mt-20 border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Mail className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            Email receptionist
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Pipe inbound Gmail into Gradia&apos;s brain — every inquiry
            becomes a Slack approval card.
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
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Connected as </span>
              <span className="font-medium text-foreground">{accountEmail}</span>
            </div>
            <div className="flex items-center justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={handleDisconnect}
                disabled={pending}
              >
                {pending ? (
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
              We&apos;ll redirect you to authorize Gmail. We only
              read inbound messages and never send without your approval.
            </p>
            <div className="flex items-center justify-end">
              {aurinkoConfigured ? (
                <a
                  href="/api/aurinko/auth/start"
                  className={buttonVariants({ variant: "default" })}
                >
                  <Plug className="size-4" aria-hidden />
                  Connect Gmail
                </a>
              ) : (
                <Button type="button" disabled>
                  Gmail coming soon
                </Button>
              )}
            </div>
            {!aurinkoConfigured ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                We're finishing email setup on our side — check back soon.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
