"use client"

import * as React from "react"
import { Check, Loader2, Phone } from "lucide-react"
import { toast } from "sonner"

import { saveVapiAssistantId } from "@/app/actions/shop"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function VoiceSettingsCard({
  initialAssistantId,
  webhookUrl,
  webhookSecretConfigured,
}: {
  initialAssistantId: string | null
  webhookUrl: string
  webhookSecretConfigured: boolean
}) {
  const [assistantId, setAssistantId] = React.useState(
    initialAssistantId ?? ""
  )
  const [savedValue, setSavedValue] = React.useState(initialAssistantId ?? "")
  const [pending, setPending] = React.useState(false)

  const isConnected = savedValue.trim().length > 0
  const isDirty = assistantId.trim() !== savedValue.trim()

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const value = assistantId.trim() || null
    setPending(true)
    const result = await saveVapiAssistantId({ vapi_assistant_id: value })
    setPending(false)

    if (!result.ok) {
      toast.error(result.error)
      return
    }

    setSavedValue(result.shop.vapi_assistant_id ?? "")
    toast.success(value ? "Voice receptionist connected." : "Disconnected.")
  }

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Phone className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            Voice receptionist
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Route calls from our Vapi assistant into Gradia&apos;s brain.
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
            Vapi dashboard, open the assistant we want to use for our calls.
          </li>
          <li>
            <span className="font-medium text-foreground">2.</span> Set the
            Server URL to{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
              {webhookUrl}
            </code>
            {webhookSecretConfigured ? null : (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}
                (and set <code>VAPI_WEBHOOK_SECRET</code> on the server — it
                isn&apos;t set yet)
              </span>
            )}
            .
          </li>
          <li>
            <span className="font-medium text-foreground">3.</span> Copy the
            assistant&apos;s ID and paste it below.
          </li>
        </ol>

        <form className="grid gap-3" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="vapi-assistant-id">Vapi assistant ID</Label>
            <Input
              id="vapi-assistant-id"
              name="vapi_assistant_id"
              placeholder="e.g. a1b2c3d4-…"
              value={assistantId}
              onChange={(e) => setAssistantId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="submit"
              disabled={pending || !isDirty}
              className="min-w-32"
            >
              {pending ? (
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
