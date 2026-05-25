"use client"

import * as React from "react"
import { AtSign, Check, ChevronDown, Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  disconnectInstagram,
  saveInstagramCredentials,
} from "@/app/actions/shop"
import { MetaPagePicker } from "@/components/gradia/meta-page-picker"
import type { MetaPagePickerOption } from "@/app/actions/meta-oauth"
import { Button, buttonVariants } from "@/components/ui/button"
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
import { cn } from "@/lib/utils"

export function InstagramSettingsCard({
  initialPageId,
  initialBusinessAccountId,
  initialHandle,
  webhookUrl,
  metaConfigured,
  pendingPages,
}: {
  initialPageId: string | null
  initialBusinessAccountId: string | null
  initialHandle: string | null
  webhookUrl: string
  metaConfigured: boolean
  pendingPages: MetaPagePickerOption[]
}) {
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [pageId, setPageId] = React.useState(initialPageId ?? "")
  const [businessAccountId, setBusinessAccountId] = React.useState(
    initialBusinessAccountId ?? ""
  )
  const [handle, setHandle] = React.useState(initialHandle ?? "")
  const [pageToken, setPageToken] = React.useState("")
  const [savedPageId, setSavedPageId] = React.useState(initialPageId ?? "")
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [pending, setPending] = React.useState<
    null | "save" | "disconnect"
  >(null)

  const isConnected = savedPageId.trim().length > 0
  const hasPicker = pendingPages.length > 0

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!pageToken.trim()) {
      toast.error("Paste a Page Access Token — it's encrypted at rest.")
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
    setPageToken("")
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
          <AtSign className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">
            Instagram DMs
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Pipe inbound IG DMs into Gradia&apos;s brain — every inquiry
            becomes an approval card.
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
        {hasPicker ? (
          <MetaPagePicker
            pendingPages={pendingPages}
            context="instagram"
          />
        ) : isConnected ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3 text-sm">
              <p className="label-eyebrow text-muted-foreground/70">
                Connected Page
              </p>
              <p className="mt-0.5 text-foreground">
                {handle ? `@${handle.replace(/^@/, "")}` : "Instagram account"}
                {businessAccountId ? (
                  <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
                    IG biz · {businessAccountId}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleDisconnect}
                disabled={pending !== null}
                className="text-muted-foreground hover:text-destructive"
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
              {metaConfigured ? (
                <a
                  href="/api/meta/auth/start?channel=instagram"
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "gap-2"
                  )}
                >
                  <FacebookMark className="size-4" />
                  Reconnect
                </a>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              One click via Facebook. Meta returns a long-lived Page
              token, we wire up the webhook for you, and inbound DMs
              start flowing into Approvals.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {metaConfigured ? (
                <a
                  href="/api/meta/auth/start?channel=instagram"
                  className={cn(
                    buttonVariants({ size: "default" }),
                    "gap-2 transition-transform duration-200 active:scale-[0.98]"
                  )}
                >
                  <FacebookMark className="size-4" />
                  Connect via Facebook
                </a>
              ) : (
                <Button type="button" disabled>
                  Meta not configured
                </Button>
              )}
            </div>
            {!metaConfigured ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Server needs <code>META_APP_ID</code>,{" "}
                <code>META_APP_SECRET</code>, and{" "}
                <code>META_WEBHOOK_VERIFY_TOKEN</code> set.
              </p>
            ) : null}
            <details
              className="rounded-xl border border-border/40 bg-card/30 px-3.5"
              open={showAdvanced}
              onToggle={(e) =>
                setShowAdvanced((e.target as HTMLDetailsElement).open)
              }
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <span>Paste tokens manually instead</span>
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform duration-200",
                    showAdvanced && "rotate-180"
                  )}
                  aria-hidden
                />
              </summary>
              <div className="space-y-4 pb-3 pt-1">
                <p className="text-xs text-muted-foreground">
                  Webhook URL Meta should point at:{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
                    {webhookUrl}
                  </code>
                </p>
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
                      <Label htmlFor="ig-token">Page Access Token</Label>
                      <Input
                        id="ig-token"
                        value={pageToken}
                        onChange={(e) => setPageToken(e.target.value)}
                        placeholder="EAAJ…"
                        autoComplete="off"
                        spellCheck={false}
                        type="password"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      disabled={pending !== null}
                      className="min-w-32"
                    >
                      {pending === "save" ? (
                        <>
                          <Loader2
                            className="size-4 animate-spin"
                            aria-hidden
                          />
                          Saving
                        </>
                      ) : (
                        "Save tokens"
                      )}
                    </Button>
                  </div>
                </form>
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Inline blue Facebook "f" mark — used as the leading icon on the
 *  OAuth CTA. Inline SVG (no extra asset round-trip) and brand-correct. */
function FacebookMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9v-2.89h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.23.2 2.23.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.87h2.77l-.44 2.89h-2.33v6.99A10 10 0 0 0 22 12z"
      />
    </svg>
  )
}
