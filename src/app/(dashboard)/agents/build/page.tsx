import Link from "next/link"

import { getAgentRevision, getAgentsHome, getBuilderResume, getSelectableMemory } from "@/app/actions/agent-definitions"
import { DtoStateNotice } from "@/components/agents/agent-parts"
import { DefinitionBuilder } from "@/components/agents/definition-builder"
import { NewAgentForm } from "@/components/agents/new-agent-form"
import { SectionHeader } from "@/components/gradia/section-header"
import { buttonVariants } from "@/components/ui/button"
import { pageStateFor } from "@/lib/agent-os/builder/states"
import { parseStepParam, parseUuidParam } from "@/lib/agent-os/builder/steps"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

/**
 * Resumable seven-step Agent builder. `?agent=<uuid>&step=<key>` are validated here; the exact
 * latest immutable revision is loaded from the server on every entry. Without `agent`, a bounded
 * name creates a disabled identity and redirects to that agent's builder.
 */
export default async function AgentBuildPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const hasAgentParam = params.agent !== undefined
  const agentId = parseUuidParam(params.agent)
  const step = parseStepParam(params.step)
  const savedParam = Array.isArray(params.saved) ? params.saved[0] : params.saved
  const justSaved = savedParam === "created" || savedParam === "replayed" ? savedParam : null

  if (hasAgentParam && !agentId) return <DtoStateNotice kind="invalid" />

  if (!agentId) {
    const home = await getAgentsHome()
    const state = pageStateFor(home)
    if (state) return <DtoStateNotice kind={state} retryHref="/agents/build" what="Gradia agents" />
    if (home.status !== "ok") return <DtoStateNotice kind="unavailable" retryHref="/agents/build" />
    return (
      <div className="mx-auto w-full max-w-xl space-y-6">
        <SectionHeader level={1} eyebrow="Gradia Agents" title="Create a Gradia agent" subhead="Name it first. You'll describe the job, choose what it may read and do, set limits and test it in seven short steps." />
        {home.data.canManage ? (
          <NewAgentForm />
        ) : (
          <div role="note" className="space-y-3 rounded-md bg-muted px-4 py-3 text-sm">
            <p>Only the workspace owner can create agents. You can review the ones that exist.</p>
            <Link href="/agents" className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
              Back to agents
            </Link>
          </div>
        )}
      </div>
    )
  }

  const retryHref = `/agents/build?agent=${agentId}&step=${step}`
  const resume = await getBuilderResume(agentId)
  const state = pageStateFor(resume)
  if (state) return <DtoStateNotice kind={state} retryHref={retryHref} what="this agent" />
  if (resume.status !== "ok") return <DtoStateNotice kind="unavailable" retryHref={retryHref} />

  const latest = resume.data.latestRevision
  const [catalog, revision] = await Promise.all([
    getSelectableMemory(),
    latest ? getAgentRevision(agentId, latest.revision) : Promise.resolve(null),
  ])

  return (
    <DefinitionBuilder
      // A new saved revision remounts the builder from the server's truth; no stale local state survives.
      key={`${agentId}:${latest?.revision ?? 0}:${latest?.definitionHash ?? "none"}`}
      resume={resume.data}
      initialStep={step}
      justSaved={justSaved}
      catalog={catalog}
      confirmedTools={revision && revision.status === "ok" ? revision.data.tools : null}
      evaluations={revision && revision.status === "ok" ? revision.data.evaluations : []}
    />
  )
}
