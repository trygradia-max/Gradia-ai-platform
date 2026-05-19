import Link from "next/link"
import { Wand2 } from "lucide-react"

import { AgentCard } from "@/components/gradia/agent-card"
import { CustomAgentCard } from "@/components/gradia/custom-agent-card"
import { buttonVariants } from "@/components/ui/button"
import {
  getAgentsForCurrentShop,
  listCustomAgentsForCurrentShop,
} from "@/lib/data/agents"

export const dynamic = "force-dynamic"

export default async function AgentsPage() {
  const [agents, customAgents] = await Promise.all([
    getAgentsForCurrentShop(),
    listCustomAgentsForCurrentShop(),
  ])
  const activeCount = agents.filter((a) => a.status === "active").length

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Our agents</h1>
          <p className="text-sm text-muted-foreground">
            What&apos;s running for us right now — and what to connect next
            to switch more on.{" "}
            <span className="font-medium text-foreground">
              {activeCount} of {agents.length} built-ins live.
            </span>
          </p>
        </div>
        <Link
          href="/agents/build"
          className={buttonVariants({ variant: "default" })}
        >
          <Wand2 className="size-4" aria-hidden />
          Build a new agent
        </Link>
      </div>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
            Built-in
          </h2>
          <p className="text-sm text-muted-foreground">
            The agents Gradia ships out of the box.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
            Our custom agents
          </h2>
          <p className="text-sm text-muted-foreground">
            Workflows we&apos;ve planned together. The runtime executor is
            coming next — for now these are saved designs.
          </p>
        </div>
        {customAgents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/80 bg-muted/15 px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing custom yet. Describe a workflow and we&apos;ll plan
              it for you.
            </p>
            <Link
              href="/agents/build"
              className={`${buttonVariants({ variant: "outline" })} mt-3 inline-flex`}
            >
              <Wand2 className="size-4" aria-hidden />
              Build a new agent
            </Link>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {customAgents.map((agent) => (
              <CustomAgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
