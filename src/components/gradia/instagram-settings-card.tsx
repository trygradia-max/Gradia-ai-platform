"use client"

import * as React from "react"
import { Aperture, Check, Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  disconnectInstagram,
  saveInstagramCredentials,
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

export function InstagramSettingsCard({
  initialPageId,
  initialBusinessAccountId,
  initialHandle,
  webhookUrl,
  metaConfigured,
}: {
  initialPageId: string | null
  initialBusinessAccountId: string | null
  initialHandle: string | null
  webhookUrl: string
  metaConfigured: boolean
}) {
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [pageId, setPageId] = React.useState(initialPageId ?? "")
  const [businessAccountId, setBusinessAccountId] = React.useState(
    initialBusinessAccountId ?? ""
  )
  const [handle, setHandle] = React.useState(initialHandle ?? "")
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
    const result = await saveInstagramCredentials({
      instagram_page_id: pageId,
      instagram_business_account_id: businessAccountId,
      instagram_account_handle: handle.trim() || null,
      instagram_page_access_token: pageToken,
    })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedPageId(result.shop.instagram_page_id ?? "")
    setPageToken("") // clear from local memory after save
    toast.success("Instagram connected.")
  }

  async function handleDisconnect() {
    const ok = await confirm({
      title: "Disconnect Instagram?",
      description:
        "Inbound DMs won't reach Gradia until you reconnect.",
      confirmLabel: "Disconnect",
      tone: "destructive",
    })
    if (!ok) return
    setPending("disconnect")
    const result = await disconnectInstagram()
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSavedPageId("")
    setBusinessAccountId("")
    setHandle("")
    setPageToken("")
    toast.success("Instagram disconnected.")
  }

  return (
    <Card id="instagram" className="scroll-mt-20 border-border/80">
      {confirmDialog}
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <Aperture className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            Instagram DMs
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Pipe inbound DMs into Gradia&apos;s brain — every inquiry
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
            Meta developer dashboard, subscribe your Facebook Page to
            this webhook:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
              {webhookUrl}
            </code>
            {metaConfigured ? null : (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}
                (and set <code>META_APP_SECRET</code> +{" "}
                <code>META_WEBHOOK_VERIFY_TOKEN</code> on the server —
                they aren&apos;t set yet)
              </span>
            )}
          </li>
          <li>
            <span className="font-medium text-foreground">2.</span> Grab
            the Page ID, IG Business Account ID, and a long-lived Page
            Access Token (with{" "}
            <code>instagram_manage_messages</code> + related scopes).
            Paste them below — we encrypt the token at rest.
          </li>
        </ol>

        <form className="grid gap-3" onSubmit={handleSave}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="ig-page-id">Facebook Page ID</Label>
              <Input
                id="ig-page-id"
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
                placeholder="e.g. 1234567890"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ig-biz-id">IG Business Account ID</Label>
              <Input
                id="ig-biz-id"
                value={businessAccountId}
                onChange={(e) => setBusinessAccountId(e.target.value)}
                placeholder="e.g. 17841400000000000"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
            <div className="grid gap-2">
              <Label htmlFor="ig-handle">@ handle (optional)</Label>
              <Input
                id="ig-handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@apexdetailing"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ig-token">
                Page Access Token {isConnected ? "(re-paste to update)" : ""}
              </Label>
              <Input
                id="ig-token"
                value={pageToken}
                onChange={(e) => setPageToken(e.target.value)}
                placeholder="EAAJ… (encrypted at rest)"
                autoComplete="off"
                spellCheck={false}
                type="password"
              />
            </div>
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
