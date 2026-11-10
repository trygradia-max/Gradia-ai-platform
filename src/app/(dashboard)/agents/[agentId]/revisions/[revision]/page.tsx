import Link from "next/link"

import { getAgentDetail, getAgentRevision } from "@/app/actions/agent-definitions"
import { DtoStateNotice, HashValue, LifecyclePill, RevisionBody, RuntimeLimitationNote } from "@/components/agents/agent-parts"
import { buttonVariants } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import { pageStateFor } from "@/lib/agent-os/builder/states"
import { parseRevisionParam, parseUuidParam } from "@/lib/agent-os/builder/steps"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

/** One immutable revision, read-only. Editing always happens by saving a NEW revision in the builder. */
export default async function RevisionPage({ params }: { params: Promise<{ agentId: string; revision: string }> }) {
  const { agentId: rawAgent, revision: rawRevision } = await params
  const agentId = parseUuidParam(rawAgent)
  const revisionNumber = parseRevisionParam(rawRevision)
  if (!agentId || revisionNumber === null) return <DtoStateNotice kind="invalid" />

  const here = `/agents/${agentId}/revisions/${revisionNumber}`
  const [revision, detail] = await Promise.all([getAgentRevision(agentId, revisionNumber), getAgentDetail(agentId)])
  const state = pageStateFor(revision)
  if (state) return <DtoStateNotice kind={state} retryHref={here} what="this revision" />
  if (revision.status !== "ok") return <DtoStateNotice kind="unavailable" retryHref={here} />

  const data = revision.data
  const canManage = detail.status === "ok" && detail.data.canManage
  const latestRevision = detail.status === "ok" ? detail.data.revisions[0]?.revision ?? null : null
  const builderHref = `/agents/build?agent=${agentId}`

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <header className="space-y-3">
        <Link href={`/agents/${agentId}`} className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:min-h-8">
          ← {detail.status === "ok" ? detail.data.name : "Agent"}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Revision {data.revision}</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill tone="muted">Read-only</StatusPill>
              {data.isActive ? <StatusPill tone="good">Active</StatusPill> : null}
              {latestRevision !== null && data.revision === latestRevision ? <StatusPill tone="muted">Latest</StatusPill> : null}
              <LifecyclePill lifecycle={data.isActive ? data.lifecycle : "draft"} />
            </div>
            <p className="text-xs text-muted-foreground">
              Hash <HashValue hash={data.definitionHash} /> · saved {new Date(data.createdAt).toLocaleString("en-US")} · {data.parentRevision ? `built from revision ${data.parentRevision}` : "first revision"}
            </p>
          </div>
          {canManage ? (
            <Link href={builderHref} className={cn(buttonVariants(), "min-h-11")}>
              {latestRevision !== null && data.revision !== latestRevision ? "Continue from the latest" : "Create new revision"}
            </Link>
          ) : null}
        </div>
        {canManage && latestRevision !== null && data.revision !== latestRevision ? (
          <p className="text-xs text-muted-foreground">Revision {latestRevision} is the latest. Edits start from it, and this revision stays unchanged.</p>
        ) : null}
      </header>
      <RuntimeLimitationNote />
      <RevisionBody revision={data} builderHref={builderHref} />
    </div>
  )
}
