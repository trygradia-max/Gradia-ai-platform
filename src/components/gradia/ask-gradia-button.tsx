"use client"

import { Sparkles } from "lucide-react"

import { openCommandBar } from "@/components/gradia/command-bar"
import { cn } from "@/lib/utils"

/**
 * Ask Gradia as a persistent top-bar action + ⌘K (BUILD_REFERENCE §2) — a verb,
 * not a nav destination. Opens the Gradia Agent command bar (read + act) in an
 * overlay; the box stays one keystroke away from every screen. (The ⌘K handler
 * itself lives in CommandBar so it works even when this button isn't focused.)
 */
export function AskGradiaButton() {
  return (
    <button
      type="button"
      onClick={() => openCommandBar()}
      className={cn(
        "inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
      )}
      aria-label="Ask Gradia"
    >
      <Sparkles className="size-4 text-primary" aria-hidden />
      <span className="hidden sm:inline">Ask Gradia</span>
      <kbd className="hidden rounded border border-border/60 bg-muted px-1.5 text-[10px] font-medium text-muted-foreground sm:inline">
        ⌘K
      </kbd>
    </button>
  )
}
