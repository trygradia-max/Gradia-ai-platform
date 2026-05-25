"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

export type MetaCallbackStatus =
  | "ok"
  | "pick"
  | "denied"
  | "missing_params"
  | "state_mismatch"
  | "not_signed_in"
  | "token_exchange_failed"
  | "page_list_failed"
  | "no_pages"
  | "subscribe_failed"
  | "save_failed"

const MESSAGES: Record<
  MetaCallbackStatus,
  { kind: "success" | "error" | "info"; text: string }
> = {
  ok: {
    kind: "success",
    text: "Meta connected — DMs will start flowing into Approvals.",
  },
  pick: {
    kind: "info",
    text: "Pick which Page we should wire up below.",
  },
  denied: {
    kind: "error",
    text: "Meta cancelled — try again when you're ready.",
  },
  missing_params: {
    kind: "error",
    text: "Something went sideways with Meta — try the connect button again.",
  },
  state_mismatch: {
    kind: "error",
    text: "Session expired mid-flow — kick off the connect again.",
  },
  not_signed_in: {
    kind: "error",
    text: "We lost your shop session — sign back in and try again.",
  },
  token_exchange_failed: {
    kind: "error",
    text: "Meta didn't return a token — try again or check the server logs.",
  },
  page_list_failed: {
    kind: "error",
    text: "Couldn't list your Pages — check the app permissions in Meta.",
  },
  no_pages: {
    kind: "error",
    text: "We didn't see any Facebook Pages on that account.",
  },
  subscribe_failed: {
    kind: "error",
    text: "Meta wouldn't let us subscribe to webhook events — try again.",
  },
  save_failed: {
    kind: "error",
    text: "Couldn't persist the connection — check the server logs.",
  },
}

/**
 * One-shot client component that surfaces the Meta OAuth callback
 * status as a toast and strips the `?meta=...` param from the URL so
 * a page reload doesn't re-fire it. Renders nothing visually.
 */
export function MetaCallbackToast({
  status,
}: {
  status: MetaCallbackStatus | null
}) {
  const router = useRouter()
  const firedRef = React.useRef(false)

  React.useEffect(() => {
    if (firedRef.current || !status) return
    firedRef.current = true
    const msg = MESSAGES[status]
    if (msg.kind === "success") toast.success(msg.text)
    else if (msg.kind === "info") toast.message(msg.text)
    else toast.error(msg.text)
    // Clean up the URL so a refresh doesn't replay the toast.
    router.replace("/settings#instagram", { scroll: false })
  }, [status, router])

  return null
}
