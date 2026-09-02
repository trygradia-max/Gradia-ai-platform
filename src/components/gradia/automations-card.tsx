"use client"

import * as React from "react"

import { HelpTip } from "@/components/gradia/help-tip"
import { STRINGS } from "@/lib/strings"
import { Loader2, Zap } from "lucide-react"
import { toast } from "sonner"

import {
  saveAutomation,
  type AutomationSettingsEntry,
} from "@/app/actions/automations"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { AutomationMode } from "@/lib/types/database"
import { cn } from "@/lib/utils"

/**
 * Automation catalog (CRM C5) — toggles, not a builder. Each entry is a
 * plain-English sentence + on/off + approval|autopilot + editable template
 * + run history. Autopilot always rides the same send gates as everything
 * else; money/calendar entries can't offer it at all (hard floor).
 */
export function AutomationsCard({ initial }: { initial: AutomationSettingsEntry[] }) {
  return (
    <Card className="border-border/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 font-display text-lg tracking-tight">
            Automations
            <HelpTip label="Automations" text={STRINGS.help.settings.automations} />
          </CardTitle>
        <p className="text-sm text-muted-foreground">
          Eight follow-ups that run themselves. Approval mode stages every
          message in Approvals; autopilot sends within your usual guardrails
          (quiet hours, opt-outs, credits).
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/60">
          {initial.map((entry) => (
            <AutomationRow key={entry.key} entry={entry} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function AutomationRow({ entry }: { entry: AutomationSettingsEntry }) {
  const [enabled, setEnabled] = React.useState(entry.enabled)
  const [mode, setMode] = React.useState<AutomationMode>(entry.mode)
  const [template, setTemplate] = React.useState(entry.template)
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  const dirty =
    enabled !== entry.enabled || mode !== entry.mode || template !== entry.template

  async function save(next?: { enabled?: boolean; mode?: AutomationMode }) {
    setSaving(true)
    const result = await saveAutomation(entry.key, {
      enabled: next?.enabled ?? enabled,
      mode: next?.mode ?? mode,
      template,
    })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Saved.")
  }

  const history = [
    entry.stats.sent > 0 ? `${entry.stats.sent} sent` : null,
    entry.stats.staged > 0 ? `${entry.stats.staged} waiting` : null,
    entry.stats.recoveredBookings > 0
      ? `recovered ${entry.stats.recoveredBookings} booking${entry.stats.recoveredBookings === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 text-left"
        >
          <p className="text-sm font-medium text-foreground">{entry.sentence}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {entry.detail}
            {history ? (
              <span className="font-data"> · {history}</span>
            ) : null}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {enabled && mode === "autopilot" ? (
            <Zap className="size-3.5 text-primary" aria-label="Runs on autopilot" />
          ) : null}
          <label className="inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saving}
              onChange={(e) => {
                setEnabled(e.target.checked)
                void save({ enabled: e.target.checked })
              }}
              className="size-4 accent-primary"
              aria-label={`Toggle: ${entry.sentence}`}
            />
          </label>
        </div>
      </div>

      {open ? (
        <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
          <div className="flex items-center gap-3">
            <Select
              value={mode}
              onValueChange={(v) => {
                if (!v) return
                setMode(v as AutomationMode)
                void save({ mode: v as AutomationMode })
              }}
            >
              <SelectTrigger className="h-8 w-56 text-xs" disabled={!entry.autopilotAllowed}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approval">Ask me first (Approvals)</SelectItem>
                {entry.autopilotAllowed ? (
                  <SelectItem value="autopilot">Send on its own (autopilot)</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {!entry.autopilotAllowed ? (
              <p className="text-xs text-muted-foreground">
                Always needs your approval — it touches money or the calendar.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Message — {"{customer_name}"}, {"{shop_name}"}, {"{quote_link}"},{" "}
              {"{review_link}"}, {"{services}"} fill in automatically.
              {entry.defaultTemplate === "" ? " Leave blank to keep the built-in copy." : ""}
            </p>
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={entry.defaultTemplate || "Built-in copy (drafted per customer)"}
              rows={3}
              className={cn("text-sm", saving && "opacity-60")}
            />
          </div>

          {dirty ? (
            <Button type="button" size="sm" disabled={saving} onClick={() => save()} className="gap-1.5">
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              Save changes
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
