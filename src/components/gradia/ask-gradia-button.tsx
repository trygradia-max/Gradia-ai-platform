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
export function AskGradiaButton({ wide = false }: { wide?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => openCommandBar()}
      className={cn(
        "inline-flex cursor-pointer items-center gap-2 border border-border/70 bg-card/60 text-sm text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:text-foreground",
        wide
          ? "h-9 w-full rounded-full px-3"
          : "rounded-full px-3 py-1.5"
      )}
      aria-label="Ask Gradia"
    >
      <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className={cn("truncate", wide ? "flex-1 text-left" : "hidden sm:inline")}>
        Ask Gradia
      </span>
      <kbd className="hidden rounded border border-border/70 bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline">
        ⌘K
      </kbd>
    </button>
  )
}
