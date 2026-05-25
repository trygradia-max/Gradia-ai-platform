"use client"

import * as React from "react"
import { Check, Globe, Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  disconnectFacebook,
  saveFacebookCredentials,
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

export function FacebookSettingsCard({
  initialPageId,
  initialPageName,
  webhookUrl,
  metaConfigured,
}: {
  initialPageId: string | null
  initialPageName: string | null
  webhookUrl: string
  metaConfigured: boolean
}) {
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [pageId, setPageId] = React.useState(initialPageId ?? "")
  const [pageName, setPageName] = React.useState(initialPageName ?? "")
  const [pageToken, setPageToken] = React.useState("")
  const [savedPageId, setSavedPageId] = React.useState(initialPageId ?? "")
  const [pending, setPending] = React.useState<
    null | "save" | "disconnect"
  >(null)

  const isConnected = savedPageId.trim().length > 0

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!pageToken.trim()) {
      toast.error(
        "Paste a Page Access Token — we never store it raw, it's encrypted at rest."
      )
      return
    }
    setPending("save")
    const result = await saveFacebookCredentials({
      facebook_page_id: pageId,
      facebook_page_name: pageName.trim() || null,
      facebook_page_access_token: pageToken,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedPageId(result.shop.facebook_page_id ?? "")
    setPageToken("")
    toast.success("Facebook connected.")
  }

  async function handleDisconnect() {
    const ok = await confirm({
      title: "Disconnect Facebook?",
      description:
        "Inbound DMs won't reach Gradia until you reconnect.",
      confirmLabel: "Disconnect",
      tone: "destructive",
    })
    if (!ok) return
    setPending("disconnect")
    const result = await disconnectFacebook()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedPageId("")
    setPageName("")
    setPageToken("")
    toast.success("Facebook disconnected.")
  }

  return (
    <Card id="facebook" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Globe className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            Facebook DMs
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Pipe inbound Page messages into Gradia — every inquiry becomes
            a Slack approval card.
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
            Meta developer dashboard, subscribe your Facebook Page to this
            webhook:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
              {webhookUrl}
            </code>
            {metaConfigured ? null : (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}
                (set <code>META_APP_SECRET</code> +{" "}
                <code>META_WEBHOOK_VERIFY_TOKEN</code> on the server first
                — they aren&apos;t set yet)
              </span>
            )}
          </li>
          <li>
            <span className="font-medium text-foreground">2.</span> Grab
            the Page ID and a long-lived Page Access Token (with{" "}
            <code>pages_messaging</code> + <code>pages_show_list</code>
            scopes). Paste them below — we encrypt the token at rest.
          </li>
        </ol>

        <form className="grid gap-3" onSubmit={handleSave}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="fb-page-id">Facebook Page ID</Label>
              <Input
                id="fb-page-id"
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
                placeholder="e.g. 1234567890"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fb-page-name">Page name (optional)</Label>
              <Input
                id="fb-page-name"
                value={pageName}
                onChange={(e) => setPageName(e.target.value)}
                placeholder="Apex Detailing"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fb-token">
              Page Access Token {isConnected ? "(re-paste to update)" : ""}
            </Label>
            <Input
              id="fb-token"
              value={pageToken}
              onChange={(e) => setPageToken(e.target.value)}
              placeholder="EAAJ… (encrypted at rest)"
              autoComplete="off"
              spellCheck={false}
              type="password"
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
              disabled={pending !== null}
              className="min-w-32"
            >
              {pending === "save" ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Saving
                </>
              ) : isConnected ? (
                "Update"
              ) : (
                "Connect"
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
