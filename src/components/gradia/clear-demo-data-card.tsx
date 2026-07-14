"use client"

import * as React from "react"
import { Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { clearDemoData } from "@/app/actions/demo-data"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * "Clear demo data" (fix-pass P2) — removes exactly the rows seed:smoke
 * marked as demo (SMOKE: names, [smoke-seed] notes, source='demo').
 * Real customers are never matched. Confirmation required.
 */
export function ClearDemoDataCard() {
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  async function run() {
    setBusy(true)
    const result = await clearDemoData()
    setBusy(false)
    setOpen(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    const total = Object.values(result.deleted).reduce((s, n) => s + n, 0)
    toast.success(
      total > 0
        ? `Cleared ${total} demo row${total === 1 ? "" : "s"} (${Object.entries(result.deleted)
            .map(([t, n]) => `${n} ${t}`)
            .join(", ")}).`
        : "No demo rows found — the books are already clean."
    )
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/30 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-foreground">Clear demo data</p>
        <p className="text-xs text-muted-foreground">
          Removes rows created by the smoke seed (marked demo). Real
          customers are never touched.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" aria-hidden />
        Clear
      </Button>

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Clear demo data?</DialogTitle>
            <DialogDescription>
              Deletes only rows carrying the demo markers — SMOKE-prefixed
              names, smoke-seed notes, and demo-sourced records. This
              can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={run} className="gap-1.5">
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              Clear demo rows
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
