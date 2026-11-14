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
import type { AgentConfig } from "@/lib/types/database"

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

export type ScheduledAgentRunClaim =
  | {
      outcome: "claimed"
      runId: string
      attempt: number
      shopId: string
      definitionSnapshot: AgentConfig
      definitionHash: string
      policyRevision: number | null
      knowledgeRevision: number | null
      /** Present only for a governed agent: the exact evidence the database bound this run to. */
      governed?: GovernedRunBinding
    }
  | {
      outcome: "active_duplicate" | "unknown" | "terminal_duplicate"
      runId: string
      attempt: number
      state?: CustomAgentRunRow["state"]
    }
  | { outcome: "agent_unavailable" }
  /** A governed definition that is not currently runnable (typed reasons). No run row exists. */
  | { outcome: "refused"; reasons: string[] }

export type GovernedRunBinding = {
  definitionRevision: number
  evaluationId: string
  memoryPins: { source_id: string; memory_revision: number; content_hash: string }[]
  activationEventSeq: number
}

type ScheduledAgentRunClaimRow = {
  outcome?: unknown
  run_id?: unknown
  attempt?: unknown
  shop_id?: unknown
  definition_snapshot?: unknown
  definition_hash?: unknown
  policy_revision?: unknown
  knowledge_revision?: unknown
  state?: unknown
  reasons?: unknown
  governed?: unknown
  definition_revision?: unknown
  evaluation_id?: unknown
  memory_pins?: unknown
  activation_event_seq?: unknown
}

function scheduledClaimFromRpc(data: unknown): ScheduledAgentRunClaim {
  const row = (data ?? {}) as ScheduledAgentRunClaimRow
  if (row.outcome === "agent_unavailable") return { outcome: row.outcome }
  if (row.outcome === "refused") {
    if (!Array.isArray(row.reasons) || row.reasons.length === 0 || !row.reasons.every((r) => typeof r === "string")) {
      throw new Error("[agent-runs] scheduled claim returned an invalid refusal")
    }
    return { outcome: "refused", reasons: row.reasons as string[] }
  }
  if (
    (row.outcome === "active_duplicate" ||
      row.outcome === "unknown" ||
      row.outcome === "terminal_duplicate") &&
    typeof row.run_id === "string" &&
    Number.isInteger(row.attempt)
  ) {
    return {
      outcome: row.outcome,
      runId: row.run_id,
      attempt: row.attempt as number,
      ...(typeof row.state === "string"
        ? { state: row.state as CustomAgentRunRow["state"] }
        : {}),
    }
  }
  if (
    row.outcome === "claimed" &&
    typeof row.run_id === "string" &&
    typeof row.shop_id === "string" &&
    Number.isInteger(row.attempt) &&
    row.definition_snapshot !== null &&
    typeof row.definition_snapshot === "object" &&
    typeof row.definition_hash === "string"
  ) {
    let governed: GovernedRunBinding | undefined
    if (row.governed === true) {
      if (
        !Number.isInteger(row.definition_revision) ||
        typeof row.evaluation_id !== "string" ||
        !Array.isArray(row.memory_pins) ||
        !Number.isInteger(row.activation_event_seq)
      ) {
        throw new Error("[agent-runs] governed claim is missing its binding")
      }
      governed = {
        definitionRevision: row.definition_revision as number,
        evaluationId: row.evaluation_id,
        memoryPins: row.memory_pins as GovernedRunBinding["memoryPins"],
        activationEventSeq: row.activation_event_seq as number,
      }
    }
    return {
      outcome: row.outcome,
      runId: row.run_id,
      attempt: row.attempt as number,
      shopId: row.shop_id,
      definitionSnapshot: row.definition_snapshot as AgentConfig,
      definitionHash: row.definition_hash,
      policyRevision:
        typeof row.policy_revision === "number" ? row.policy_revision : null,
      knowledgeRevision:
        typeof row.knowledge_revision === "number"
          ? row.knowledge_revision
          : null,
      ...(governed ? { governed } : {}),
    }
  }
  throw new Error("[agent-runs] scheduled claim returned an invalid response")
}

/** Claim one schedule window before recipe work. Duplicates never execute. An
 * expired claim is moved to unknown by the database and is not reclaimed. */
export async function claimScheduledAgentRun(
  supabase: SupabaseClient,
  input: {
    agentId: string
    triggerKey: string
    workerId: string
    leaseSeconds?: number
  }
): Promise<ScheduledAgentRunClaim> {
  const { data, error } = await supabase.rpc("claim_scheduled_agent_run", {
    p_agent: input.agentId,
    p_trigger_key: input.triggerKey,
    p_worker: input.workerId,
    p_lease_seconds: input.leaseSeconds ?? 120,
  })
  if (error) {
    throw new Error(`[agent-runs] scheduled claim failed: ${error.message}`)
  }
  return scheduledClaimFromRpc(data)
}

export async function finishScheduledAgentRun(
  supabase: SupabaseClient,
  input: {
    runId: string
    workerId: string
    attempt: number
    state: "succeeded" | "skipped" | "failed"
    fired: boolean
    reason?: string
    stats?: Record<string, number>
    pendingActionIds?: string[]
    errorCode?: string
  }
): Promise<boolean> {
  const { data, error } = await supabase.rpc("finish_scheduled_agent_run", {
    p_run: input.runId,
    p_worker: input.workerId,
    p_attempt: input.attempt,
    p_state: input.state,
    p_fired: input.fired,
    p_reason: input.reason ?? null,
    p_stats: input.stats ?? null,
    p_pending_action_ids: input.pendingActionIds ?? [],
    p_error_code: input.errorCode ?? null,
  })
  if (error) {
    throw new Error(`[agent-runs] scheduled finish failed: ${error.message}`)
  }
  return data === true
}

export type GovernedRunCheck = { current: boolean; governed: boolean; reasons: string[] }

/**
 * Re-verify a running run's binding before an effect. Legacy runs answer `{current:true,
 * governed:false}`, so the executor may call this unconditionally. Any error or malformed answer
 * is `current: false`: an unverifiable binding is never treated as current.
 */
export async function assertGovernedRunCurrent(
  supabase: SupabaseClient,
  input: { runId: string; workerId: string; attempt: number }
): Promise<GovernedRunCheck> {
  const { data, error } = await supabase.rpc("assert_governed_run_current", {
    p_run: input.runId,
    p_worker: input.workerId,
    p_attempt: input.attempt,
  })
  const row = (data ?? {}) as { current?: unknown; governed?: unknown; reasons?: unknown }
  if (
    error ||
    typeof row.current !== "boolean" ||
    typeof row.governed !== "boolean" ||
    !Array.isArray(row.reasons) ||
    !row.reasons.every((r) => typeof r === "string")
  ) {
    return { current: false, governed: true, reasons: ["binding_unverifiable"] }
  }
  return { current: row.current, governed: row.governed, reasons: row.reasons as string[] }
}

/**
 * Agents that have a definition state row are governed: they run only through a bound claim.
 * Throws when it cannot tell, so callers fail closed instead of running a governed agent as legacy.
 */
export async function loadGovernedAgentStates(
  supabase: SupabaseClient,
  agentIds: string[]
): Promise<Map<string, { lifecycle: string; activeRevision: number | null }>> {
  const out = new Map<string, { lifecycle: string; activeRevision: number | null }>()
  if (agentIds.length === 0) return out
  for (let i = 0; i < agentIds.length; i += 200) {
    const { data, error } = await supabase
      .from("agent_definition_state")
      .select("agent_id,lifecycle,active_revision")
      .in("agent_id", agentIds.slice(i, i + 200))
    if (error) throw new Error(`[agent-runs] governed state lookup failed: ${error.message}`)
    for (const row of (data ?? []) as { agent_id: string; lifecycle: string; active_revision: number | null }[]) {
      out.set(row.agent_id, { lifecycle: row.lifecycle, activeRevision: row.active_revision })
    }
  }
  return out
}

export async function markScheduledAgentRunUnknown(
  supabase: SupabaseClient,
  runId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc(
    "mark_scheduled_agent_run_unknown",
    { p_run: runId }
  )
  if (error) {
    throw new Error(`[agent-runs] unknown mark failed: ${error.message}`)
  }
  return data === true
}

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
    state: input.outcome.fired ? "succeeded" : "skipped",
    attempt: 1,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
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
