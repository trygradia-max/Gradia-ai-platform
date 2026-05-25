"use client"

import * as React from "react"
import { Check, Loader2, MessageSquare } from "lucide-react"
import { toast } from "sonner"

import {
  clearTwilioCredentials,
  disconnectSms,
  saveTwilioCredentials,
  saveTwilioNumber,
} from "@/app/actions/shop"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { StatusPill } from "@/components/ui/status-pill"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function SmsSettingsCard({
  initialPhoneNumber,
  webhookUrl,
  twilioConfigured,
  byoConnected: initialByoConnected,
}: {
  initialPhoneNumber: string | null
  webhookUrl: string
  twilioConfigured: boolean
  byoConnected: boolean
}) {
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [phone, setPhone] = React.useState(initialPhoneNumber ?? "")
  const [savedValue, setSavedValue] = React.useState(initialPhoneNumber ?? "")
  const [pending, setPending] = React.useState<
    null | "save" | "disconnect" | "save_byo" | "clear_byo"
  >(null)
  const [byoConnected, setByoConnected] = React.useState(initialByoConnected)
  const [accountSid, setAccountSid] = React.useState("")
  const [authToken, setAuthToken] = React.useState("")

  const isConnected = savedValue.trim().length > 0
  const isDirty = phone.trim() !== savedValue.trim()

  async function handleSaveCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending("save_byo")
    const result = await saveTwilioCredentials({
      twilio_account_sid: accountSid.trim(),
      twilio_auth_token: authToken.trim(),
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setByoConnected(true)
    setAccountSid("")
    setAuthToken("")
    toast.success("Twilio credentials saved — your account is now used for this shop.")
  }

  async function handleClearCredentials() {
    const ok = await confirm({
      title: "Clear your Twilio credentials?",
      description:
        "Outbound SMS falls back to Gradia's pilot account until you paste them again.",
      confirmLabel: "Clear",
      tone: "destructive",
    })
    if (!ok) return
    setPending("clear_byo")
    const result = await clearTwilioCredentials()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setByoConnected(false)
    toast.success("Cleared — falling back to Gradia's pilot account.")
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const value = phone.trim() || null
    setPending("save")
    const result = await saveTwilioNumber({ twilio_phone_number: value })
    setPending(null)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    const next = result.shop.twilio_phone_number ?? ""
    setSavedValue(next)
    setPhone(next)
    toast.success(value ? "SMS connected." : "Disconnected.")
  }

  async function handleDisconnect() {
    setPending("disconnect")
    const result = await disconnectSms()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedValue("")
    setPhone("")
    toast.success("SMS disconnected.")
  }

  return (
    <Card id="sms" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <MessageSquare className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            SMS receptionist
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Point our Twilio number at Gradia&apos;s brain — every text
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
      <CardContent className="space-y-5">
        <ol className="grid gap-3 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">1.</span> In the
            Twilio console, open the phone number we want to use.
          </li>
          <li>
            <span className="font-medium text-foreground">2.</span> Under
            Messaging → A Message Comes In, set the webhook to{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
              {webhookUrl}
            </code>{" "}
            with method <strong>HTTP POST</strong>.
            {twilioConfigured ? null : (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}
                (and set <code>TWILIO_ACCOUNT_SID</code> +{" "}
                <code>TWILIO_AUTH_TOKEN</code> on the server — they
                aren&apos;t set yet)
              </span>
            )}
          </li>
          <li>
            <span className="font-medium text-foreground">3.</span> Paste
            the number below in E.164 format (e.g. <code>+15551234567</code>).
          </li>
        </ol>

        <form className="grid gap-3" onSubmit={handleSave}>
          <div className="grid gap-2">
            <Label htmlFor="twilio-number">Our Twilio number</Label>
            <Input
              id="twilio-number"
              name="twilio_phone_number"
              placeholder="+15551234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="off"
              inputMode="tel"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {isConnected ? (
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
            ) : null}
            <Button
              type="submit"
              disabled={pending !== null || !isDirty}
              className="min-w-32"
            >
              {pending === "save" ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Saving
                </>
              ) : isConnected && !isDirty ? (
                "Saved"
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </form>

        <div className="space-y-3 rounded-lg border border-dashed border-border/60 bg-muted/15 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Use your own Twilio account</p>
              <p className="text-xs text-muted-foreground">
                Recommended past the pilot — your own deliverability,
                A2P registration, and Twilio bill. Encrypted at rest.
              </p>
            </div>
            {byoConnected ? (
              <StatusPill
                tone="good"
                icon={<Check className="size-3" aria-hidden />}
              >
                BYO
              </StatusPill>
            ) : null}
          </div>

          <form className="grid gap-3" onSubmit={handleSaveCredentials}>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="twilio-sid">Account SID</Label>
                <Input
                  id="twilio-sid"
                  value={accountSid}
                  onChange={(e) => setAccountSid(e.target.value)}
                  placeholder="AC…"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="twilio-token">
                  Auth Token {byoConnected ? "(re-paste to update)" : ""}
                </Label>
                <Input
                  id="twilio-token"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder="••••••••"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending !== null}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {byoConnected ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClearCredentials}
                  disabled={pending !== null}
                  className="h-11 sm:h-9"
                >
                  {pending === "clear_byo" ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  Clear
                </Button>
              ) : null}
              <Button
                type="submit"
                disabled={
                  pending !== null ||
                  !accountSid.trim() ||
                  !authToken.trim()
                }
                className="h-11 min-w-32 sm:h-9"
              >
                {pending === "save_byo" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Saving
                  </>
                ) : byoConnected ? (
                  "Update credentials"
                ) : (
                  "Save credentials"
                )}
              </Button>
            </div>
          </form>
        </div>
      </CardContent>
    </Card>
  )
}
