"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { BiChat } from "@/components/gradia/bi-chat"
import { Dialog, DialogContent } from "@/components/ui/dialog"

/**
 * The Gradia Agent command bar (FOCUS spec §4.2 — "a verb, not a page").
 * A global overlay, callable from anywhere via ⌘K (desktop) or the openCommandBar()
 * helper (the top-bar "Ask Gradia" button + the mobile composer). It hosts the
 * same read+act agent box the /agent page uses, streaming tool-status feedback
 * as it works ("Sizing up the audience…", "Staging drafts for approval…").
 *
 * Decoupled by a window event so any trigger can open it without prop-drilling
 * a context through the whole tree.
 */
const OPEN_EVENT = "gradia:open-command-bar"

/** Open the command bar from anywhere (client-side only). */
export function openCommandBar(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function CommandBar() {
  const [open, setOpen] = React.useState(false)
  // Remount the box each time we open so it starts fresh (the agent is a verb —
  // every invocation is "what should we get done now," not a resumed thread).
  const [sessionKey, setSessionKey] = React.useState(0)

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    function onOpen() {
      setSessionKey((k) => k + 1)
      setOpen(true)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[8%] w-full max-w-2xl translate-y-0 gap-0 border-border/60 bg-transparent p-0 shadow-2xl sm:max-w-2xl"
      >
        {/* Visually-hidden title keeps the dialog accessible without a visible
            header — the box brings its own chrome. */}
        <DialogPrimitive.Title className="sr-only">
          Ask Gradia
        </DialogPrimitive.Title>
        <BiChat
          key={sessionKey}
          initial={{ conversationId: null, messages: [] }}
          endpoint="/api/agent/chat"
          resetHref={null}
        />
      </DialogContent>
    </Dialog>
  )
}
