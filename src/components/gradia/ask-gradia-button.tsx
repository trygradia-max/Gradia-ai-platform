"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Sparkles } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Ask Gradia as a persistent top-bar action + ⌘K (BUILD_REFERENCE §2) — a verb,
 * not a nav destination. Routes to the Gradia Agent box (read + act); the old
 * read-only /chat page is demoted (FOCUS spec §1).
 */
export function AskGradiaButton() {
  const router = useRouter()

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        router.push("/agent")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [router])

  return (
    <button
      type="button"
      onClick={() => router.push("/agent")}
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
