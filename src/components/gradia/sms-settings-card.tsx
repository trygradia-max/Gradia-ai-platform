"use client"

import * as React from "react"
import { Check, Loader2, MessageSquare } from "lucide-react"
import { toast } from "sonner"

import { disconnectSms, saveTwilioNumber } from "@/app/actions/shop"
import { Button } from "@/components/ui/button"
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
}: {
  initialPhoneNumber: string | null
  webhookUrl: string
  twilioConfigured: boolean
}) {
  const [phone, setPhone] = React.useState(initialPhoneNumber ?? "")
  const [savedValue, setSavedValue] = React.useState(initialPhoneNumber ?? "")
  const [pending, setPending] = React.useState<null | "save" | "disconnect">(
    null
  )

  const isConnected = savedValue.trim().length > 0
  const isDirty = phone.trim() !== savedValue.trim()

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
    <Card className="border-border/80">
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
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-3" aria-hidden />
            Connected
          </span>
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
      </CardContent>
    </Card>
  )
}
