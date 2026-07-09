"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { saveWorkingHours } from "@/app/actions/working-hours"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  WEEKDAY_LABELS,
  WEEKDAYS,
  type WorkingHours,
} from "@/lib/working-hours"

/**
 * Working hours (C4 follow-up): one place, two consumers — the calendar's
 * over-capacity warning and the hours the receptionist speaks on the phone.
 */
export function WorkingHoursCard({ initial }: { initial: WorkingHours }) {
  const [hours, setHours] = React.useState<WorkingHours>(initial)
  const [saving, setSaving] = React.useState(false)

  function setDay(day: (typeof WEEKDAYS)[number], patch: Partial<{ open: string; close: string; closed: boolean }>) {
    setHours((prev) => {
      const current = prev[day]
      if (patch.closed !== undefined) {
        return {
          ...prev,
          [day]: patch.closed ? null : { open: "09:00", close: "17:00" },
        }
      }
      if (!current) return prev
      return { ...prev, [day]: { ...current, ...patch } }
    })
  }

  async function save() {
    setSaving(true)
    const result = await saveWorkingHours(hours)
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Hours saved — the calendar and your receptionist both know.")
  }

  return (
    <Card className="border-border/60">
      <CardHeader>
        <CardTitle className="font-display text-lg tracking-tight">
          Working hours
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Sets when a day counts as overbooked on the Calendar, and what the
          receptionist tells callers about your hours.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {WEEKDAYS.map((day) => {
          const h = hours[day]
          return (
            <div key={day} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-sm text-muted-foreground">
                {WEEKDAY_LABELS[day]}
              </span>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={h === null}
                  onChange={(e) => setDay(day, { closed: e.target.checked })}
                  className="size-4 accent-primary"
                />
                Closed
              </label>
              {h ? (
                <>
                  <Input
                    type="time"
                    value={h.open}
                    onChange={(e) => setDay(day, { open: e.target.value })}
                    className="h-8 w-28"
                    aria-label={`${WEEKDAY_LABELS[day]} opening time`}
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    value={h.close}
                    onChange={(e) => setDay(day, { close: e.target.value })}
                    className="h-8 w-28"
                    aria-label={`${WEEKDAY_LABELS[day]} closing time`}
                  />
                </>
              ) : null}
            </div>
          )
        })}
        <div className="pt-2">
          <Button type="button" size="sm" disabled={saving} onClick={save} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Save hours
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
