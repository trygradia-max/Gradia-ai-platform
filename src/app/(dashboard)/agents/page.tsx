import { AgentCard } from "@/components/gradia/agent-card"
import { getAgentsForCurrentShop } from "@/lib/data/agents"

export const dynamic = "force-dynamic"

export default async function AgentsPage() {
  const agents = await getAgentsForCurrentShop()
  const activeCount = agents.filter((a) => a.status === "active").length

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Our agents</h1>
        <p className="text-sm text-muted-foreground">
          What&apos;s running for us right now — and what to connect next to
          switch more on.{" "}
          <span className="font-medium text-foreground">
            {activeCount} of {agents.length} live.
          </span>
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  )
}
