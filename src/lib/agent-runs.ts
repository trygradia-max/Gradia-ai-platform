/**
 * Per-fire history for custom agents. Recorded by the runtime at
 * three points (manual fires, schedule cron, event dispatch) so the
 * /agents UI can show a Recent Activity drawer.
 *
 * We deliberately suppress cron noise — skipping for "schedule not
 * open" or "fired recently" produces millions of rows over time
 * without telling the operator anything useful. Other skips (Twilio
 * missing, recipe missing, etc.) are loud and get logged.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { AgentRunOutcome } from "@/lib/agent-runtime"
import type { CustomAgentRunRow } from "@/lib/types/database"

const SUPPRESS_PREFIXES = [
  "hour ",
  "weekday ",
  "fired recently",
  "no schedule",
]

export function shouldRecordOutcome(
  outcome: AgentRunOutcome,
  trigger: TriggerSource
): boolean {
  if (outcome.fired) return true
  if (trigger === "manual") return true // operator clicked; always tell them
  if (!outcome.reason) return true
  const reason = outcome.reason.toLowerCase()
  return !SUPPRESS_PREFIXES.some((p) => reason.startsWith(p))
}

export type TriggerSource =
  | "manual"
  | "schedule"
  | `event:${string}`

export async function recordAgentRun(
  supabase: SupabaseClient,
  input: {
    agentId: string
    shopId: string
    triggerSource: TriggerSource
    outcome: AgentRunOutcome
  }
): Promise<void> {
  if (!shouldRecordOutcome(input.outcome, input.triggerSource)) return
  const { error } = await supabase.from("custom_agent_runs").insert({
    agent_id: input.agentId,
    shop_id: input.shopId,
    trigger_source: input.triggerSource,
    fired: input.outcome.fired,
    reason: input.outcome.reason ?? null,
    stats: input.outcome.stats ?? null,
    pending_action_ids: input.outcome.pendingActionIds ?? [],
  })
  if (error) {
    console.error("[agent-runs] insert failed:", error)
  }
}

export async function listAgentRunsForShop(
  supabase: SupabaseClient,
  input: { agentId: string; shopId: string; limit?: number }
): Promise<CustomAgentRunRow[]> {
  const { data, error } = await supabase
    .from("custom_agent_runs")
    .select("*")
    .eq("agent_id", input.agentId)
    .eq("shop_id", input.shopId)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 30)
  if (error) {
    console.error("[agent-runs] list failed:", error)
    return []
  }
  return (data as CustomAgentRunRow[] | null) ?? []
}
