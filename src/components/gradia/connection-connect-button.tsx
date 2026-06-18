"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Client-only Connect button for OAuth tiles: opens a centered popup, listens
 * for the same-origin gradia-oauth message, refreshes on success, and falls
 * back to a full-page redirect if the popup is blocked. Kept separate from
 * ConnectionTile so the tile can stay a Server Component (and take an icon).
 */
export function ConnectionConnectButton({ href }: { href: string }) {
  const router = useRouter()
  const [connecting, setConnecting] = React.useState(false)

  function openPopup() {
    setConnecting(true)
    const w = 520
    const h = 680
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2)
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2)
    const win = window.open(
      href,
      "gradia-oauth",
      `width=${w},height=${h},left=${left},top=${top}`
    )
    if (!win) {
      window.location.href = href
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

  return (
    <Button
      type="button"
      size="sm"
      onClick={openPopup}
      disabled={connecting}
      className="gap-2"
    >
      {connecting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {connecting ? "Connecting…" : "Connect"}
    </Button>
  )
}
