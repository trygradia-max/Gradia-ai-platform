"use client"

import * as React from "react"
import Link from "next/link"
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { listAgentRuns } from "@/app/actions/custom-agents"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import type { CustomAgentRunRow } from "@/lib/types/database"

function relative(iso: string): string {
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

function triggerLabel(source: string): string {
  if (source === "manual") return "Run-now"
  if (source === "schedule") return "Scheduled"
  if (source.startsWith("event:")) {
    return `Event · ${source.slice("event:".length).replace(/_/g, " ")}`
  }
  return source
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

export function AgentRunsSheet({
  agentId,
  agentName,
}: {
  agentId: string
  agentName: string
}) {
  const [open, setOpen] = React.useState(false)
  const [runs, setRuns] = React.useState<CustomAgentRunRow[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const loadIdRef = React.useRef(0)

  async function load() {
    const myId = ++loadIdRef.current
    setLoading(true)
    const result = await listAgentRuns(agentId)
    if (myId !== loadIdRef.current) return
    if (!result.ok) {
      toast.error(result.error)
      setRuns([])
    } else {
      setRuns(result.runs)
    }
    setLoading(false)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) void load()
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="gap-1.5 text-xs"
          />
        }
      >
        <Activity className="size-3.5" aria-hidden />
        Activity
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{agentName}</SheetTitle>
          <SheetDescription>
            Recent fires — what triggered, when, and what landed.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-1 py-3">
          {loading || runs === null ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              Loading…
            </div>
          ) : runs.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              No activity yet — runs show up here once we&apos;ve fired
              this agent.
            </p>
          ) : (
            <ul className="grid gap-2 px-1">
              {runs.map((run) => {
                const summary = statsSummary(run.stats)
                return (
                  <li
                    key={run.id}
                    className="rounded-md border border-border/60 bg-muted/15 px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2">
                      {run.fired ? (
                        <CheckCircle2
                          className="mt-0.5 size-3.5 shrink-0 text-status-success-fg"
                          aria-hidden
                        />
                      ) : (
                        <XCircle
                          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <StatusPill tone="muted">
                            {triggerLabel(run.trigger_source)}
                          </StatusPill>
                          <span className="flex items-center gap-1 tabular-nums">
                            <Clock className="size-3" aria-hidden />
                            {relative(run.created_at)}
                          </span>
                        </div>
                        {run.fired ? (
                          <p className="mt-1 text-sm">
                            {summary ?? "Fired."}
                          </p>
                        ) : (
                          <p className="mt-1 text-sm text-muted-foreground">
                            {run.reason ?? "Skipped."}
                          </p>
                        )}
                        {run.pending_action_ids?.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {run.pending_action_ids
                              .slice(0, 4)
                              .map((pid, i) => (
                                <Link
                                  key={pid}
                                  href={`/approvals/${pid}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
                                  onClick={() => setOpen(false)}
                                >
                                  Approval {i + 1}
                                  <ArrowUpRight
                                    className="size-3"
                                    aria-hidden
                                  />
                                </Link>
                              ))}
                            {run.pending_action_ids.length > 4 ? (
                              <span className="text-[11px] text-muted-foreground">
                                +{run.pending_action_ids.length - 4} more
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
