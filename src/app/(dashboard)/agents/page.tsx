import Link from "next/link"
import { Wand2 } from "lucide-react"

import { AgentCard } from "@/components/gradia/agent-card"
import { CustomAgentCard } from "@/components/gradia/custom-agent-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import { SectionHeader } from "@/components/gradia/motion/section-header"
import { buttonVariants } from "@/components/ui/button"
import { readAutonomy } from "@/lib/autonomy"
import {
  getAgentsForCurrentShop,
  getLatestRunsByAgent,
  listCustomAgentsForCurrentShop,
} from "@/lib/data/agents"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

export default async function AgentsPage() {
  const [agents, customAgents] = await Promise.all([
    getAgentsForCurrentShop(),
    listCustomAgentsForCurrentShop(),
  ])
  const lastRuns = await getLatestRunsByAgent(customAgents.map((a) => a.id))
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data: shopRow } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shopCtx.id)
    .single()
  const autonomy = readAutonomy({
    settings:
      (shopRow as { settings?: Record<string, unknown> } | null)?.settings ?? {},
  })
  const activeCount = agents.filter((a) => a.status === "active").length
  const enabledCustom = customAgents.filter((a) => a.enabled).length

  return (
    <div className="mx-auto max-w-6xl space-y-12">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">Agents</p>
          <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
            What&apos;s <span className="italic">running</span> for us.
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            {`${activeCount} of ${agents.length} built-ins live`}
            {customAgents.length > 0
              ? ` · ${enabledCustom} of ${customAgents.length} custom on`
              : ""}
            . Pick what to switch on next, or design a new one from scratch.
          </p>
        </div>
        <Link
          href="/agents/build"
          className={cn(
            buttonVariants({ size: "lg" }),
            "h-11 gap-2 shrink-0"
          )}
        >
          <Wand2 className="size-4" aria-hidden />
          Build a new agent
        </Link>
      </header>

      <section className="space-y-5">
        <SectionHeader
          eyebrow="Built-in"
          title={
            <>
              Out of the <span className="italic">box</span>.
            </>
          }
          subtitle="The agents Gradia ships ready to go — connect the channel, switch them on."
        />
        <PageStagger className="grid gap-4 md:grid-cols-2">
          {agents.map((agent) => (
            <StaggerItem key={agent.id} className="h-full">
              <AgentCard agent={agent} />
            </StaggerItem>
          ))}
        </PageStagger>
      </section>

      <section className="space-y-5">
        <SectionHeader
          eyebrow="Custom"
          title={
            <>
              Workflows we&apos;ve <span className="italic">planned</span>.
            </>
          }
          subtitle="Agents designed for our shop. Edit the plan, run on demand, or pause anytime."
        />
        {customAgents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/60 bg-muted/10 px-6 py-14 text-center">
            <p className="font-display text-xl text-foreground sm:text-2xl">
              <span className="italic">Nothing</span> custom yet.
            </p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
              Describe a workflow in plain English — &ldquo;text new leads
              we haven&apos;t heard from in 3 days&rdquo; — and we&apos;ll
              plan the whole thing.
            </p>
            <Link
              href="/agents/build"
              className={cn(
                buttonVariants({ variant: "default", size: "lg" }),
                "mt-5 h-11 gap-2"
              )}
            >
              <Wand2 className="size-4" aria-hidden />
              Plan one with us
            </Link>
          </div>
        ) : (
          <PageStagger className="grid gap-4 md:grid-cols-2">
            {customAgents.map((agent) => (
              <StaggerItem key={agent.id} className="h-full">
                <CustomAgentCard
                  agent={agent}
                  lastRun={lastRuns.get(agent.id) ?? null}
                  initialMode={autonomy.overrides[agent.id] ?? autonomy.default}
                />
              </StaggerItem>
            ))}
          </PageStagger>
        )}
      </section>
    </div>
  )
}
