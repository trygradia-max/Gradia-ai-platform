import { getAgentsHome } from "@/app/actions/agent-definitions"
import { getBaselineStartingPoint } from "@/app/actions/onboarding-baseline"
import { AgentsHomeView } from "@/components/agents/agents-home-view"
import { DtoStateNotice } from "@/components/agents/agent-parts"
import { StartingPointAgentsNotice } from "@/components/gradia/starting-point/starting-point-status-card"

export const dynamic = "force-dynamic"

/**
 * Agent OS home. Tenant data is loaded on the server through the session-derived Build 1 action; a forbidden
 * or unavailable read renders its own state and is NEVER an empty list. While no Starting point exists, a
 * plain notice points to it (a failed read of that status shows nothing here; Home and Settings say so).
 */
export default async function AgentsPage() {
  const [home, startingPoint] = await Promise.all([
    getAgentsHome(),
    getBaselineStartingPoint().catch(() => ({ status: "unavailable" }) as const),
  ])
  if (home.status === "forbidden") return <DtoStateNotice kind="forbidden" what="Gradia agents" />
  if (home.status === "unavailable") return <DtoStateNotice kind="unavailable" retryHref="/agents" what="your agents" />
  return <AgentsHomeView home={home.data} notice={<StartingPointAgentsNotice dto={startingPoint} />} />
}
