"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  Play,
  Send,
  Target,
  Trash2,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import {
  deleteCustomAgent,
  runCustomAgentNow,
  setCustomAgentEnabled,
} from "@/app/actions/custom-agents"
import { AgentModeControl } from "@/components/gradia/agent-mode-control"
import { AgentRunsSheet } from "@/components/gradia/agent-runs-sheet"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import { PulseDot } from "@/components/gradia/motion/pulse-dot"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { StatusPill } from "@/components/ui/status-pill"
import type { AutonomyMode } from "@/lib/autonomy"
import type {
  AgentConfig,
  CustomAgentRow,
  CustomAgentRunRow,
} from "@/lib/types/database"
import { cn } from "@/lib/utils"

const ACTION_LABEL: Record<AgentConfig["action"]["kind"], string> = {
  draft_sms: "Drafts an SMS for approval",
  draft_email: "Drafts an email for approval",
  log_note: "Logs a note in memory",
  flag_for_review: "Flags for review",
}

function relativeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 14) return `${days} days ago`
  const weeks = Math.round(days / 7)
  return `${weeks} wk${weeks === 1 ? "" : "s"} ago`
}

function statsSummary(stats: Record<string, number> | null): string | null {
  if (!stats) return null
  const parts: string[] = []
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v !== "number") continue
    parts.push(`${v} ${k.replace(/_/g, " ")}`)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

export function CustomAgentCard({
  agent,
  lastRun,
  initialMode,
}: {
  agent: CustomAgentRow
  lastRun: CustomAgentRunRow | null
  initialMode: AutonomyMode
}) {
  const router = useRouter()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [pending, setPending] = React.useState<
    null | "delete" | "run" | "toggle"
  >(null)
  const [enabled, setEnabled] = React.useState(agent.enabled)
  const config = agent.config
  const runnable = Boolean(config.recipe?.id || config.freeform)
  const isLive = enabled && runnable

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete ${agent.name}?`,
      description: "The plan and its run history go with it.",
      confirmLabel: "Delete agent",
      tone: "destructive",
    })
    if (!ok) return
    setPending("delete")
    const result = await deleteCustomAgent(agent.id)
    setPending(null)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success("Deleted. Gone for good.")
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
    const auto = stats?.auto_executed ?? 0
    const proposed =
      (stats?.proposed_sms ?? 0) +
      (stats?.proposed_email ?? 0) +
      (stats?.proposed ?? 0)
    const summary =
      auto > 0
        ? `Sent ${auto} automatically.`
        : proposed > 0
          ? `Staged ${proposed} draft${proposed === 1 ? "" : "s"} in Approvals.`
          : "Ran — no targets matched."
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
    toast.success(next ? "Live — we'll run it on schedule." : "Paused.")
  }

  return (
    <MotionCard
      interactive
      glow={isLive}
      className={cn(
        "relative flex h-full flex-col overflow-hidden p-5 sm:p-6",
        // Status-coded accent rail on the left edge.
        isLive &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-[''] before:bg-gradient-to-b before:from-emerald-400/40 before:via-emerald-400/15 before:to-transparent",
        !isLive &&
          enabled &&
          runnable === false &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:content-[''] before:bg-gradient-to-b before:from-muted-foreground/30 before:via-muted-foreground/10 before:to-transparent"
      )}
    >
      {confirmDialog}

      <header className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
            isLive
              ? "bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-400"
              : "bg-primary/12 text-primary ring-primary/25"
          )}
        >
          <Bot className="size-[18px]" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="flex items-center gap-1.5 font-display text-lg leading-tight tracking-tight text-foreground">
              <span className="truncate">{agent.name}</span>
              {isLive ? (
                <PulseDot tone="good" size={5} className="shrink-0" />
              ) : null}
            </h3>
            {!runnable ? (
              <StatusPill tone="muted">Plan only</StatusPill>
            ) : enabled ? (
              <StatusPill tone="good">Live</StatusPill>
            ) : (
              <StatusPill tone="warn">Paused</StatusPill>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {agent.description ?? config.short_description}
          </p>
        </div>
      </header>

      <div className="mt-5 flex flex-1 flex-col gap-4">
        <ConfigRow
          icon={Clock}
          eyebrow="When"
          primary={
            config.trigger.kind === "schedule"
              ? config.trigger.schedule_summary || "On a schedule"
              : config.trigger.event_summary || "On an event"
          }
        />
        <ConfigRow
          icon={Target}
          eyebrow="Who"
          primary={
            <span className="capitalize">{config.audience.entity}</span>
          }
          secondaryList={config.audience.filters_summary.slice(0, 3)}
        />
        <ConfigRow
          icon={Send}
          eyebrow="Does"
          primary={ACTION_LABEL[config.action.kind]}
          secondary={config.action.intent_summary}
        />

        {lastRun ? (
          <LastRunPanel run={lastRun} />
        ) : !runnable ? (
          <p className="rounded-lg border border-dashed border-border/50 px-3.5 py-2.5 text-xs text-muted-foreground">
            Recreate this agent to enable it — the runtime needs the latest
            recipe wired in.
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-2">
          {runnable ? (
            <AgentModeControl
              agentKey={agent.id}
              initialMode={initialMode}
              className="mr-auto"
            />
          ) : null}
          <AgentRunsSheet agentId={agent.id} agentName={agent.name} />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={pending !== null}
            className="gap-1.5 text-muted-foreground transition-colors hover:text-destructive"
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
                {enabled ? "Pause" : "Turn it on"}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </MotionCard>
  )
}

function ConfigRow({
  icon: Icon,
  eyebrow,
  primary,
  secondary,
  secondaryList,
}: {
  icon: typeof Clock
  eyebrow: string
  primary: React.ReactNode
  secondary?: React.ReactNode
  secondaryList?: string[]
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-background/60 ring-1 ring-border/50">
        <Icon
          className="size-3.5 text-muted-foreground/80"
          aria-hidden
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="label-eyebrow text-muted-foreground/70">{eyebrow}</p>
        <p className="mt-0.5 text-sm text-foreground/90">{primary}</p>
        {secondary ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{secondary}</p>
        ) : null}
        {secondaryList && secondaryList.length > 0 ? (
          <ul className="mt-0.5 grid gap-0.5 text-xs text-muted-foreground">
            {secondaryList.map((f, i) => (
              <li key={i}>• {f}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

function LastRunPanel({ run }: { run: CustomAgentRunRow }) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        {run.fired ? (
          <CheckCircle2
            className="mt-0.5 size-4 shrink-0 text-emerald-500 dark:text-emerald-400"
            aria-hidden
          />
        ) : (
          <XCircle
            className="mt-0.5 size-4 shrink-0 text-muted-foreground/80"
            aria-hidden
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="label-eyebrow text-muted-foreground/70">
              Last run
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {relativeAgo(run.created_at)}
            </p>
          </div>
          <p className="mt-0.5 text-sm text-foreground/90">
            {run.fired
              ? (statsSummary(run.stats) ?? "Fired.")
              : (run.reason ?? "Skipped — nothing matched.")}
          </p>
        </div>
      </div>
    </div>
  )
}
