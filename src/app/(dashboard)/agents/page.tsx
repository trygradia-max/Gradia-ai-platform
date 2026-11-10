import { getAgentsHome } from "@/app/actions/agent-definitions"
import { AgentsHomeView } from "@/components/agents/agents-home-view"
import { DtoStateNotice } from "@/components/agents/agent-parts"

export const dynamic = "force-dynamic"

/**
 * Agent OS home. Tenant data is loaded on the server through the session-derived Build 1
 * action; a forbidden or unavailable read renders its own state and is NEVER an empty list.
 */
export default async function AgentsPage() {
  const home = await getAgentsHome()
  if (home.status === "forbidden") return <DtoStateNotice kind="forbidden" what="Gradia agents" />
  if (home.status === "unavailable") return <DtoStateNotice kind="unavailable" retryHref="/agents" what="your agents" />
  return <AgentsHomeView home={home.data} />
}
