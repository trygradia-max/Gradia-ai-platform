import Link from "next/link"
import { Plus } from "lucide-react"

import { LifecyclePill, RuntimeLimitationNote } from "@/components/agents/agent-parts"
import { EmptyState } from "@/components/gradia/empty-state"
import { SectionHeader } from "@/components/gradia/section-header"
import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { StatusPill } from "@/components/ui/status-pill"
import { governanceLabel } from "@/lib/agent-os/builder/labels"
import type { AgentsHomeDto, AgentSummaryDto } from "@/lib/agent-os/definition-dto"
import { cn } from "@/lib/utils"

function RevisionLine({ agent }: { agent: AgentSummaryDto }) {
  const href = (revision: number) => `/agents/${agent.agentId}/revisions/${revision}`
  if (agent.governance === "legacy_unversioned" && !agent.latestRevision) {
    return <p className="text-xs text-muted-foreground">No saved definition yet.</p>
  }
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        Active:{" "}
        {agent.activeRevision ? (
          <Link href={href(agent.activeRevision.revision)} className="font-medium text-foreground underline underline-offset-2">
            Revision {agent.activeRevision.revision}
          </Link>
        ) : (
          <span className="text-foreground">none</span>
        )}
      </span>
      <span>
        Latest:{" "}
        {agent.latestRevision ? (
          <Link href={href(agent.latestRevision.revision)} className="font-medium text-foreground underline underline-offset-2">
            Revision {agent.latestRevision.revision}
          </Link>
        ) : (
          <span className="text-foreground">none</span>
        )}
      </span>
      {agent.hasUnactivatedDraft ? <StatusPill tone="accent">Newer draft</StatusPill> : null}
    </p>
  )
}

function AgentCardView({ agent }: { agent: AgentSummaryDto }) {
  return (
    <li>
      <Card className="gap-3 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-foreground">
            <Link href={`/agents/${agent.agentId}`} className="underline-offset-2 hover:underline focus-visible:underline">
              {agent.name}
            </Link>
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={agent.governance === "governed" ? "accent" : "muted"}>{governanceLabel(agent.governance)}</StatusPill>
            <LifecyclePill lifecycle={agent.lifecycle} />
          </div>
        </div>
        <RevisionLine agent={agent} />
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Last confirmed run</dt>
            <dd className="text-foreground">
              {agent.lastConfirmedRun ? new Date(agent.lastConfirmedRun.finishedAt).toLocaleString("en-US") : "No confirmed run yet"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Needs your review</dt>
            <dd className="text-foreground">
              {agent.needsReviewCount === null ? <span>Unavailable right now</span> : <span className="font-data">{agent.needsReviewCount}</span>}
            </dd>
          </div>
        </dl>
      </Card>
    </li>
  )
}

export function AgentsHomeView({ home }: { home: AgentsHomeDto }) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <SectionHeader
        level={1}
        eyebrow="Gradia Agents"
        title="Your Gradia agents"
        subhead="One agent system. Every agent is a saved, reviewable definition that Gradia checks before it is allowed to act. Nothing runs until an owner activates it."
        action={
          home.canManage ? (
            <Link href="/agents/build" className={cn(buttonVariants(), "min-h-11 gap-1.5")}>
              <Plus className="size-4" aria-hidden />
              Create Gradia agent
            </Link>
          ) : (
            <p className="max-w-56 text-xs text-muted-foreground">Only the workspace owner can create or activate agents. You can review them.</p>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm" aria-label="Active agents">
        <p>
          <span className="font-data text-foreground">{home.activeAgentCount}</span>
          <span className="text-muted-foreground"> of </span>
          <span className="font-data text-foreground">{home.activeAgentLimit}</span>
          <span className="text-muted-foreground"> active agents in your Founder Pilot workspace</span>
        </p>
        <Link href="/receptionist" className="text-accent-text underline-offset-4 hover:underline">
          Receptionist and channel agents
        </Link>
      </div>

      <RuntimeLimitationNote />

      {home.agents.length === 0 ? (
        <EmptyState
          title="No Gradia agents yet"
          description="Create one to describe a job, choose what it may read and do, and set its limits. You can build and test without a card."
          action={
            home.canManage ? (
              <Link href="/agents/build" className={cn(buttonVariants(), "min-h-11")}>
                Create Gradia agent
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2" aria-label="Gradia agents">
          {home.agents.map((agent) => (
            <AgentCardView key={agent.agentId} agent={agent} />
          ))}
        </ul>
      )}
    </div>
  )
}
