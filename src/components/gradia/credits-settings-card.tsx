"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { updateCreditLimit } from "@/app/actions/billing"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"

export function CreditsSettingsCard({
  spent,
  limit,
}: {
  spent: number
  limit: number
}) {
  const [value, setValue] = React.useState(String(limit))
  const [saving, setSaving] = React.useState(false)

  async function save() {
    if (saving) return
    setSaving(true)
    const result = await updateCreditLimit(Number(value))
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Credit limit updated.")
  }

  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0

  return (
    <Card className="border-border/60">
      <CardHeader className="space-y-1">
        <CardTitle className="font-display text-lg tracking-tight">
          Usage &amp; limits
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {spent} of {limit} credits used this period. Autopilot pauses when the
          cap is hit, so it can never run away on cost.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="credit-limit">Monthly credit limit</Label>
          <div className="flex gap-2">
            <input
              id="credit-limit"
              type="number"
              min={0}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-36 rounded-md border border-border bg-background px-3 py-2 text-sm tabular-nums"
            />
            <Button onClick={save} disabled={saving} className="gap-2">
              {saving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
