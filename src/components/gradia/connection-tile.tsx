"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, Loader2, type LucideIcon } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The Connections screen tile (BUILD_REFERENCE §4). One integration, status as
 * icon + text. Three states: not connected (coral Connect), connecting (popup
 * open), connected (✓ + identity + Manage). When `popup` is set, Connect opens
 * a centered OAuth popup and flips the tile inline on success — no full-page
 * redirect, no toast-hunting.
 */
export function ConnectionTile({
  icon: Icon,
  name,
  description,
  connected,
  available = true,
  connectedLabel,
  connectedDetail,
  connectHref,
  manageHref,
  popup = false,
}: {
  icon: LucideIcon
  name: string
  description: string
  connected: boolean
  available?: boolean
  connectedLabel?: string | null
  connectedDetail?: string | null
  connectHref?: string
  manageHref?: string
  popup?: boolean
}) {
  const router = useRouter()
  const [connecting, setConnecting] = React.useState(false)

  function openPopup() {
    if (!connectHref) return
    setConnecting(true)
    const w = 520
    const h = 680
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2)
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2)
    const win = window.open(
      connectHref,
      "gradia-oauth",
      `width=${w},height=${h},left=${left},top=${top}`
    )
    // Popup blocked → fall back to a full-page redirect.
    if (!win) {
      window.location.href = connectHref
      return
    }

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if ((e.data as { source?: string } | null)?.source !== "gradia-oauth")
        return
      cleanup()
      router.refresh()
    }
    const poll = window.setInterval(() => {
      if (win.closed) {
        cleanup()
        router.refresh()
      }
    }, 600)
    function cleanup() {
      window.removeEventListener("message", onMessage)
      window.clearInterval(poll)
      setConnecting(false)
    }
    window.addEventListener("message", onMessage)
  }

  const connectedLine =
    [connectedLabel, connectedDetail].filter(Boolean).join(" · ") || description

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-card/40 p-5 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60 text-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="size-3.5" aria-hidden /> Connected
          </span>
        ) : connecting ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Waiting…
          </span>
        ) : null}
      </div>

      <div className="space-y-1">
        <p className="font-medium text-foreground">{name}</p>
        <p className="text-sm text-muted-foreground">
          {connected
            ? connectedLine
            : connecting
              ? "Waiting for you to finish in the popup…"
              : description}
        </p>
      </div>

      <div className="mt-auto pt-1">
        {!available ? (
          <span className="text-xs text-muted-foreground/70">
            Setup needed on the server
          </span>
        ) : connected ? (
          manageHref ? (
            <Link
              href={manageHref}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Manage
            </Link>
          ) : null
        ) : !connectHref ? null : popup ? (
          <Button
            type="button"
            size="sm"
            onClick={openPopup}
            disabled={connecting}
            className="gap-2"
          >
            {connecting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {connecting ? "Connecting…" : "Connect"}
          </Button>
        ) : (
          <Link
            href={connectHref}
            className={cn(buttonVariants({ size: "sm" }), "gap-2")}
          >
            Connect
          </Link>
        )}
      </div>
    </div>
  )
}
