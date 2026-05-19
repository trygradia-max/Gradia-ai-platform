"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { planAgentFromProblem } from "@/lib/agent-planner"
import { runCustomAgent, type AgentRunOutcome } from "@/lib/agent-runtime"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { AgentConfig, CustomAgentRow } from "@/lib/types/database"

export type PlanAgentResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; error: string }

export async function planAgent(problem: string): Promise<PlanAgentResult> {
  await requireUser()
  await requireShop()
  return planAgentFromProblem(problem)
}

const saveSchema = z.object({
  problem_text: z.string().trim().min(1).max(2000),
  config: z.unknown(),
})

export type SaveAgentResult =
  | { ok: true; agent: CustomAgentRow }
  | { ok: false; error: string }

/**
 * Persists a planned agent. We trust the config object that came out
 * of the planner (already validated by zod inside agent-planner.ts);
 * here we just confirm shape minimally and write the row.
 */
export async function saveCustomAgent(input: {
  problem_text: string
  config: AgentConfig
}): Promise<SaveAgentResult> {
  const parsed = saveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "Couldn't save — the plan was malformed." }
  }
  const config = parsed.data.config as AgentConfig
  if (!config?.name || !config?.short_description) {
    return { ok: false, error: "The plan is missing a name or description." }
  }

  const user = await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("custom_agents")
    .insert({
      shop_id: shop.id,
      owner_id: user.id,
      name: config.name,
      description: config.short_description,
      problem_text: parsed.data.problem_text,
      config,
      enabled: false, // runtime executor not built yet
    })
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Couldn't save the agent." }
  }

  revalidatePath("/agents")
  return { ok: true, agent: data as CustomAgentRow }
}

export type DeleteAgentResult =
  | { ok: true }
  | { ok: false; error: string }

export async function deleteCustomAgent(
  agentId: string
): Promise<DeleteAgentResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { error } = await supabase
    .from("custom_agents")
    .delete()
    .eq("id", agentId)
    .eq("shop_id", shop.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/agents")
  return { ok: true }
}

export type RunNowResult =
  | { ok: true; outcome: AgentRunOutcome }
  | { ok: false; error: string }

/**
 * "Run now" — manually fire a single agent regardless of cadence. The
 * operator already explicitly clicked, so we bypass the schedule
 * window check. Useful for verifying a saved plan actually does
 * something before flipping the enabled toggle.
 */
export async function runCustomAgentNow(
  agentId: string
): Promise<RunNowResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("custom_agents")
    .select("*")
    .eq("id", agentId)
    .eq("shop_id", shop.id)
    .single()
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Agent not found." }
  }

  const outcome = await runCustomAgent(supabase, data as CustomAgentRow)
  revalidatePath("/agents")
  revalidatePath("/approvals")
  return { ok: true, outcome }
}

export type SetEnabledResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Toggle is wired but the runtime executor doesn't exist yet, so
 * "enabled" is currently informational. We surface that to the
 * operator in the UI ("Saved · runtime coming soon").
 */
export async function setCustomAgentEnabled(input: {
  agent_id: string
  enabled: boolean
}): Promise<SetEnabledResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { error } = await supabase
    .from("custom_agents")
    .update({ enabled: input.enabled })
    .eq("id", input.agent_id)
    .eq("shop_id", shop.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/agents")
  return { ok: true }
}
