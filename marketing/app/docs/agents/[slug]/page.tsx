import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { AGENTS } from "@/lib/site"
import { AGENT_ICON, AGENT_TILE } from "@/components/icons"
import { cn } from "@/lib/utils"
import {
  DocHeader,
  DocProse,
  CheckList,
  Callout,
  DocPager,
} from "@/components/docs/doc-shell"

export function generateStaticParams() {
  return AGENTS.map((a) => ({ slug: a.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const agent = AGENTS.find((a) => a.slug === slug)
  if (!agent) return {}
  return {
    title: `${agent.name} — Docs`,
    description: agent.oneLiner,
  }
}

export default async function AgentDocPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const agent = AGENTS.find((a) => a.slug === slug)
  if (!agent) notFound()

  const Icon = AGENT_ICON[agent.iconKey]

  return (
    <>
      <DocHeader
        eyebrow="Agent"
        title={agent.name}
        intro={agent.oneLiner}
      />

      <div className="mt-8 flex items-center gap-3">
        <div
          className={cn(
            "flex size-12 items-center justify-center rounded-xl ring-1",
            AGENT_TILE[agent.iconKey]
          )}
        >
          <Icon className="size-5" aria-hidden />
        </div>
        <span className="rounded-full border border-border/60 bg-card/50 px-3 py-1 font-mono text-xs text-muted-foreground">
          Built on {agent.stack}
        </span>
      </div>

      {agent.image && (
        <div className="mt-6 overflow-hidden rounded-2xl border border-border/60">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={agent.image}
            alt={`${agent.name} — Gradia`}
            className="aspect-[16/9] w-full object-cover"
          />
        </div>
      )}

      <DocProse>
        <h2>What it does</h2>
        <p>{agent.description}</p>

        <h2>Capabilities</h2>
      </DocProse>

      <CheckList items={agent.capabilities} />

      <DocProse>
        <Callout title="Human-in-the-loop, always">
          {agent.name} drafts and proposes — it never sends on its own. Every
          customer-facing action waits for your one-tap approval in Slack. See{" "}
          <a href="/docs/human-in-the-loop">Human-in-the-loop</a> for the full
          model.
        </Callout>
      </DocProse>

      <DocPager href={`/docs/agents/${agent.slug}`} />
    </>
  )
}
