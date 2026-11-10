import Link from "next/link"
import { Pencil } from "lucide-react"

import { LifecycleControls } from "@/components/agents/lifecycle-controls"
import { HashValue, LifecyclePill, RevisionBody, RuntimeLimitationNote, Section } from "@/components/agents/agent-parts"
import { buttonVariants } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import { governanceLabel } from "@/lib/agent-os/builder/labels"
import type { AgentDetailDto } from "@/lib/agent-os/definition-dto"
import { cn } from "@/lib/utils"

export function AgentDetailView({ detail }: { detail: AgentDetailDto }) {
  const latest = detail.revisions[0] ?? null
  const active = detail.activeRevision
  const activeRevision = active?.revision ?? null
  const builderHref = `/agents/build?agent=${detail.agentId}`
  const governed = detail.governance === "governed"
  const newerDraft = Boolean(latest && (activeRevision === null || latest.revision > activeRevision))

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <header className="space-y-3">
        <Link href="/agents" className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:min-h-8">
          ← All agents
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{detail.name}</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill tone={governed ? "accent" : "muted"}>{governanceLabel(detail.governance)}</StatusPill>
              <LifecyclePill lifecycle={detail.lifecycle} />
              {newerDraft ? <StatusPill tone="accent">Newer draft</StatusPill> : null}
            </div>
            {detail.lifecycleReason ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Reason:</span> {detail.lifecycleReason}
              </p>
            ) : null}
          </div>
          {detail.canManage ? (
            <Link href={builderHref} className={cn(buttonVariants(), "min-h-11 gap-1.5")}>
              <Pencil className="size-4" aria-hidden />
              {latest ? "Continue in builder" : "Define this agent"}
            </Link>
          ) : (
            <p className="max-w-56 text-xs text-muted-foreground">Only the workspace owner can edit or activate. You can review everything here.</p>
          )}
        </div>
      </header>

      <RuntimeLimitationNote />

      {!governed ? (
        <section aria-label="Legacy agent" className="space-y-1 rounded-md bg-muted px-4 py-3 text-sm">
          <p className="font-medium text-foreground">This is a legacy agent.</p>
          <p className="text-muted-foreground">
            It was created before saved revisions, so it has no definition to review here. To govern it, save a first revision in the builder.{" "}
            {detail.enabled ? "It is currently turned on: turn it off from the Receptionist page first, then save its first revision." : "It is turned off, so you can start now."}
          </p>
        </section>
      ) : null}

      {detail.activeRevision ? (
        <Section id="active" title={`Active definition: revision ${detail.activeRevision.revision}`} description="Exactly what is turned on. Saved revisions never change.">
          <p className="text-xs text-muted-foreground">
            Hash <HashValue hash={detail.activeRevision.definitionHash} /> · saved {new Date(detail.activeRevision.createdAt).toLocaleString("en-US")}
          </p>
          <RevisionBody revision={detail.activeRevision} builderHref={builderHref} />
        </Section>
      ) : governed ? (
        <section aria-label="No active definition" className="rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
          No revision is active. The agent does not run. {latest ? <Link href={`${builderHref}&step=activate`} className="underline underline-offset-2">Review readiness</Link> : null}
        </section>
      ) : null}

      {governed && detail.activeRevision && detail.canManage && detail.lifecycle === "active" ? (
        <Section id="control" title="Pause or block" description="Stops this agent from starting new runs. Turning it back on is a fresh activation.">
          <LifecycleControls agentId={detail.agentId} expectedPointer={detail.activeRevision.revision} />
        </Section>
      ) : null}

      {governed && (detail.lifecycle === "paused" || detail.lifecycle === "blocked") ? (
        <p role="note" className="text-sm text-muted-foreground">
          To resume, activate a revision again from the builder. Gradia re-checks everything first.
        </p>
      ) : null}

      <Section id="history" title="Revision history" description="Every save is a new, read-only revision.">
        {detail.revisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No revisions saved yet.</p>
        ) : (
          <ol className="divide-y divide-border rounded-md ring-1 ring-border">
            {detail.revisions.map((rev) => {
              const isActive = rev.revision === activeRevision
              const isLatest = rev.revision === latest?.revision
              return (
                <li key={rev.revision} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                  <div className="space-y-0.5">
                    <Link href={`/agents/${detail.agentId}/revisions/${rev.revision}`} className="font-medium text-foreground underline underline-offset-2">
                      Revision {rev.revision}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {new Date(rev.createdAt).toLocaleString("en-US")} · from {rev.parentRevision ? `revision ${rev.parentRevision}` : "scratch"} · <HashValue hash={rev.definitionHash} />
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {isActive ? <StatusPill tone="good">Active</StatusPill> : activeRevision !== null && rev.revision < activeRevision ? <StatusPill tone="muted">Superseded</StatusPill> : <StatusPill tone="accent">Draft</StatusPill>}
                    {isLatest ? <StatusPill tone="muted">Latest</StatusPill> : null}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Section>

      <Section id="manage" title="Removing this agent">
        <p className="text-sm text-muted-foreground">
          {governed ? "Agents with saved revisions can't be deleted, because their history is kept. Pause or block them instead." : "Legacy agents can be managed from the Receptionist page."}
        </p>
      </Section>

      <Section id="runs" title="Run history">
        <p className="text-sm text-muted-foreground">
          Run history lives in the existing agent activity view.{" "}
          <Link href="/receptionist" className="underline underline-offset-2">
            Open Receptionist and channel agents
          </Link>
          .
        </p>
      </Section>
    </div>
  )
}
