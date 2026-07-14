"use client"

import * as React from "react"
import { Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { whisperCustomerSummary } from "@/app/actions/whisper-tools"
import { Button } from "@/components/ui/button"

/**
 * One-tap customer summary (C6b) — a metered single-turn worker over this
 * customer's jobs, vehicles, quotes, and channel history. Facts come from
 * the DB; the model may only rephrase them (deterministic fallback when
 * it can't run).
 */
export function CustomerSummaryCard({ customerId }: { customerId: string }) {
  const [summary, setSummary] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function summarize() {
    setBusy(true)
    const result = await whisperCustomerSummary(customerId)
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setSummary(result.summary)
  }

  return (
    <div className="rounded-md border border-border/60 bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="label-eyebrow text-muted-foreground/70">The short version</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          disabled={busy}
          onClick={summarize}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-3.5" aria-hidden />
          )}
          {summary ? "Refresh" : "Summarize"}
        </Button>
      </div>
      {summary ? (
        <p className="mt-2 text-sm text-foreground">{summary}</p>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          One tap for the whole relationship — jobs, money, vehicles, and how
          they like to be reached.
        </p>
      )}
    </div>
  )
}
