"use client"

import * as React from "react"
import Link from "next/link"
import { Check, Loader2, Pencil, Sparkles, X } from "lucide-react"
import { toast } from "sonner"

import { approveFromDashboard } from "@/app/actions/approvals"
import {
  dismissWhisperSuggestion,
  type WhisperSuggestion,
} from "@/app/actions/whisper-queue"
import { Button } from "@/components/ui/button"

/**
 * "What I'd tackle next" (C6a) — Whisper's staged suggestions on Today.
 * Every card: the grounded WHY (DB facts only, written by code), the draft,
 * and Approve / Edit / Dismiss. Approve = the same one-tap executor path as
 * /approvals; Edit hands off to the Approvals edit surface; Dismiss records
 * feedback. Renders nothing when the queue is empty (nonzero rule).
 */
export function WhisperSuggestionQueue({ initial }: { initial: WhisperSuggestion[] }) {
  const [items, setItems] = React.useState(initial)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  if (items.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 text-muted-foreground/60" aria-hidden />
        Nothing to suggest right now — ideas appear here as quotes go quiet,
        follow-ups come due, or leads sit untouched for two weeks. Checked
        every few minutes.
      </p>
    )
  }

  async function approve(id: string) {
    setBusyId(id)
    const result = await approveFromDashboard(id)
    setBusyId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Sent — it's on their phone and on the timeline.")
    setItems((prev) => prev.filter((s) => s.pendingId !== id))
  }

  async function dismiss(id: string) {
    setBusyId(id)
    const result = await dismissWhisperSuggestion(id)
    setBusyId(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setItems((prev) => prev.filter((s) => s.pendingId !== id))
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <p className="label-eyebrow text-muted-foreground/70">
          What I&apos;d tackle next · {items.length}
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {items.slice(0, 3).map((s) => (
          <div
            key={s.pendingId}
            className="flex flex-col rounded-md border border-border/60 bg-card p-4"
          >
            <p className="text-sm font-medium text-foreground">
              {s.customerName ?? "A customer"}
            </p>
            {/* The why — grounded, code-written, never model-invented. */}
            <p className="mt-1 text-xs text-muted-foreground">{s.why}</p>
            <p className="mt-3 flex-1 rounded-lg bg-muted/40 px-3 py-2 text-sm text-foreground">
              {s.body}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1"
                disabled={busyId === s.pendingId}
                onClick={() => approve(s.pendingId)}
              >
                {busyId === s.pendingId ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-3.5" aria-hidden />
                )}
                Approve
              </Button>
              <Link
                href="/approvals"
                className="inline-flex h-8 items-center gap-1 rounded-sm border border-border/60 px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1 text-muted-foreground"
                disabled={busyId === s.pendingId}
                onClick={() => dismiss(s.pendingId)}
              >
                <X className="size-3.5" aria-hidden />
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
