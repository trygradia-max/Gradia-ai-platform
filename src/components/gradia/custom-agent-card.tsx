"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Bot,
  Clock,
  Loader2,
  Play,
  Send,
  Target,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import {
  deleteCustomAgent,
  runCustomAgentNow,
  setCustomAgentEnabled,
} from "@/app/actions/custom-agents"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { AgentConfig, CustomAgentRow } from "@/lib/types/database"

const ACTION_LABEL: Record<AgentConfig["action"]["kind"], string> = {
  draft_sms: "Drafts an SMS for approval",
  draft_email: "Drafts an email for approval",
  log_note: "Logs a note in memory",
  flag_for_review: "Flags for review",
}

export function CustomAgentCard({ agent }: { agent: CustomAgentRow }) {
  const router = useRouter()
  const [pending, setPending] = React.useState<
    null | "delete" | "run" | "toggle"
  >(null)
  const [enabled, setEnabled] = React.useState(agent.enabled)
  const config = agent.config
  const runnable = Boolean(config.recipe?.id)

  async function handleDelete() {
    if (!confirm(`Delete "${agent.name}"? The plan goes with it.`)) return
    setPending("delete")
    const result = await deleteCustomAgent(agent.id)
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Deleted.")
    router.refresh()
  }

  async function handleRunNow() {
    setPending("run")
    const result = await runCustomAgentNow(agent.id)
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    if (!result.outcome.fired) {
      toast.message(
        result.outcome.reason ?? "Nothing to do — agent didn't fire."
      )
      return
    }
    const stats = result.outcome.stats
    const summary = stats?.proposed_sms
      ? `Staged ${stats.proposed_sms} draft${stats.proposed_sms === 1 ? "" : "s"} in Approvals.`
      : "Ran, no targets matched."
    toast.success(summary)
    router.refresh()
  }

  async function handleToggle() {
    const next = !enabled
    setPending("toggle")
    setEnabled(next) // optimistic
    const result = await setCustomAgentEnabled({
      agent_id: agent.id,
      enabled: next,
    })
    setPending(null)
    if (!result.ok) {
      setEnabled(!next)
      toast.error(result.error)
      return
    }
    toast.success(next ? "Agent enabled." : "Agent paused.")
  }

  return (
    <Card className="flex h-full flex-col border-border/80">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <Bot className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base font-medium">
              {agent.name}
            </CardTitle>
            {!runnable ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Plan only · recreate to enable
              </span>
            ) : enabled ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                Enabled
              </span>
            ) : (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Paused
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {agent.description ?? config.short_description}
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="grid gap-3 text-sm">
          <div className="flex items-start gap-2">
            <Clock
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div>
              <span className="text-xs uppercase tracking-widest text-muted-foreground">
                When
              </span>
              <p>
                {config.trigger.kind === "schedule"
                  ? config.trigger.schedule_summary || "On a schedule"
                  : config.trigger.event_summary || "On an event"}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Target
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div>
              <span className="text-xs uppercase tracking-widest text-muted-foreground">
                Who
              </span>
              <p className="capitalize">{config.audience.entity}</p>
              {config.audience.filters_summary.length > 0 ? (
                <ul className="mt-0.5 text-xs text-muted-foreground">
                  {config.audience.filters_summary.slice(0, 3).map((f, i) => (
                    <li key={i}>• {f}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Send
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div>
              <span className="text-xs uppercase tracking-widest text-muted-foreground">
                Does
              </span>
              <p>{ACTION_LABEL[config.action.kind]}</p>
              <p className="text-xs text-muted-foreground">
                {config.action.intent_summary}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={pending !== null}
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            {pending === "delete" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-3.5" aria-hidden />
            )}
            Delete
          </Button>
          {runnable ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRunNow}
                disabled={pending !== null}
                className="gap-1.5"
              >
                {pending === "run" ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Play className="size-3.5" aria-hidden />
                )}
                Run now
              </Button>
              <Button
                type="button"
                size="sm"
                variant={enabled ? "secondary" : "default"}
                onClick={handleToggle}
                disabled={pending !== null}
                className="gap-1.5"
              >
                {pending === "toggle" ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : null}
                {enabled ? "Pause" : "Enable"}
              </Button>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
