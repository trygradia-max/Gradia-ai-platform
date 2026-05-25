"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { AtSign, Check, Globe, Loader2, X } from "lucide-react"
import { toast } from "sonner"

import {
  connectMetaPage,
  dismissMetaPagePicker,
  type MetaPagePickerOption,
} from "@/app/actions/meta-oauth"
import { EASE_OUT_EXPO } from "@/components/gradia/motion/page-stagger"
import { cn } from "@/lib/utils"

/**
 * Inline picker that lists the Pages returned by the Meta OAuth
 * callback when the operator manages more than one. Sits inside the
 * IG / FB settings card whenever `pendingPages` has rows.
 */
export function MetaPagePicker({
  pendingPages,
  /** Which surface the picker is rendered on — only used for the
   *  success toast wording, not the wire-up itself. */
  context,
}: {
  pendingPages: MetaPagePickerOption[]
  context: "instagram" | "facebook"
}) {
  const router = useRouter()
  const reduce = useReducedMotion()
  const [pending, setPending] = React.useState<string | null>(null)
  const [dismissing, setDismissing] = React.useState(false)

  async function handlePick(pageId: string) {
    setPending(pageId)
    const result = await connectMetaPage({ pageId })
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      context === "instagram" && result.hasInstagram
        ? "Instagram connected via Facebook Page."
        : context === "instagram" && !result.hasInstagram
          ? "Facebook Page connected — no IG account is linked to this Page yet."
          : "Facebook Page connected."
    )
    router.refresh()
  }

  async function handleDismiss() {
    setDismissing(true)
    await dismissMetaPagePicker()
    setDismissing(false)
    router.refresh()
  }

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key="picker"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
        className="space-y-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="label-eyebrow text-muted-foreground/70">
              Pick a Page
            </p>
            <p className="text-sm text-foreground">
              Meta returned more than one Page — pick the one we should
              wire up.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={dismissing}
            aria-label="Cancel"
            className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <ul className="grid gap-2">
          {pendingPages.map((p) => {
            const isBusy = pending === p.pageId
            return (
              <li key={p.pageId}>
                <button
                  type="button"
                  onClick={() => handlePick(p.pageId)}
                  disabled={pending !== null || dismissing}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3 text-left transition-colors",
                    "hover:border-border hover:bg-muted/25",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  )}
                >
                  <div
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1",
                      p.hasInstagram
                        ? "bg-pink-500/12 text-pink-500 ring-pink-500/25 dark:text-pink-400"
                        : "bg-indigo-500/12 text-indigo-500 ring-indigo-500/25 dark:text-indigo-400"
                    )}
                  >
                    {p.hasInstagram ? (
                      <AtSign className="size-4" aria-hidden />
                    ) : (
                      <Globe className="size-4" aria-hidden />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {p.pageName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.hasInstagram
                        ? p.instagramHandle
                          ? `Facebook + Instagram (@${p.instagramHandle})`
                          : "Facebook + Instagram (linked)"
                        : "Facebook only — no IG account on this Page"}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {isBusy ? (
                      <Loader2
                        className="size-4 animate-spin text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      <Check
                        className="size-4 text-muted-foreground/60 transition-colors group-hover:text-primary"
                        aria-hidden
                      />
                    )}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      </motion.div>
    </AnimatePresence>
  )
}
