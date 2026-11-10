import { getAgentDetail } from "@/app/actions/agent-definitions"
import { AgentDetailView } from "@/components/agents/agent-detail-view"
import { DtoStateNotice } from "@/components/agents/agent-parts"
import { pageStateFor } from "@/lib/agent-os/builder/states"
import { parseUuidParam } from "@/lib/agent-os/builder/steps"

export const dynamic = "force-dynamic"

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId: raw } = await params
  const agentId = parseUuidParam(raw)
  if (!agentId) return <DtoStateNotice kind="invalid" />
  const detail = await getAgentDetail(agentId)
  const state = pageStateFor(detail)
  if (state) return <DtoStateNotice kind={state} retryHref={`/agents/${agentId}`} what="this agent" />
  if (detail.status !== "ok") return <DtoStateNotice kind="unavailable" retryHref={`/agents/${agentId}`} />
  return <AgentDetailView detail={detail.data} />
}
