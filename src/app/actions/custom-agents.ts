"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  previewFreeformPlan,
  type FreeformPreview,
} from "@/lib/agent-audience"
import { parseAgentConfig } from "@/lib/agent-config-schema"
import { planAgentFromProblem } from "@/lib/agent-planner"
import { listAgentRunsForShop } from "@/lib/agent-runs"
import { recordUsage } from "@/lib/credits"
import { getPricing, priceUsage } from "@/lib/pricing"
import { runCustomAgent, type AgentRunOutcome } from "@/lib/agent-runtime"
import { FEATURES } from "@/lib/features"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type {
  AgentConfig,
  CustomAgentRow,
  CustomAgentRunRow,
  ShopRow,
} from "@/lib/types/database"

export type PlanAgentResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; error: string }

export async function planAgent(problem: string): Promise<PlanAgentResult> {
  await requireUser()
  const shop = await requireShop()
  const result = await planAgentFromProblem(problem)
  if (result.ok) {
    // Locked menu: 10 credits per agentic-mode plan.
    const supabase = await createClient()
    const priced = priceUsage(await getPricing(supabase), "agentic_plan", 1)
    await recordUsage(supabase, shop.id, "agentic_plan", {
      credits: priced.credits,
      wholesaleCost: priced.wholesale_cost,
      retailCost: priced.retail_cost,
    })
  }
  return result
}

export type PreviewAgentResult =
  | { ok: true; preview: FreeformPreview }
  | { ok: false; error: string }

/**
 * Dry-run a free-form plan before enabling it: returns the resolved recipient
 * count + a few real sample drafts. Reads only — stages and sends nothing.
 */
export async function previewCustomAgentPlan(
  rawConfig: AgentConfig
): Promise<PreviewAgentResult> {
  await requireUser()
  const shopCtx = await requireShop()
  if (!FEATURES.freeformPlanner) {
    return { ok: false, error: "Free-form preview isn't enabled yet." }
  }
  // P0-011 (audit M-2): the config arrives from the client — validate the
  // full runtime shape (whitelisted filter keys, bounded values) before the
  // audience resolver sees any of it.
  const validated = parseAgentConfig(rawConfig)
  if (!validated.ok) {
    return { ok: false, error: validated.error }
  }
  const config = validated.config
  if (!config.freeform) {
    return {
      ok: false,
      error: "This plan has no free-form audience to preview.",
    }
  }
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = data as ShopRow | null
  if (!shop) return { ok: false, error: "Shop not found." }
  try {
    const preview = await previewFreeformPlan(supabase, shop, config.freeform)
    return { ok: true, preview }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't build a preview.",
    }
  }
}

const saveSchema = z.object({
  problem_text: z.string().trim().min(1).max(2000),
  // P0-011 (audit M-2): was `z.unknown()` cast to AgentConfig — the client
  // could persist arbitrary keys/values into custom_agents.config. The real
  // runtime-shape validation happens via parseAgentConfig below.
  config: z.unknown(),
})

export type SaveAgentResult =
  | { ok: true; agent: CustomAgentRow }
  | { ok: false; error: string }

/**
 * Persists a planned agent. The planner validated what IT emitted, but this
 * action is client-invocable with any payload — so the config is re-validated
 * server-side against the runtime's accepted shape (P0-011 / audit M-2)
 * before it lands in custom_agents.config.
 */
export async function saveCustomAgent(input: {
  problem_text: string
  config: AgentConfig
}): Promise<SaveAgentResult> {
  const parsed = saveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: "Couldn't save — the plan was malformed." }
  }
  const validated = parseAgentConfig(parsed.data.config)
  if (!validated.ok) {
    return { ok: false, error: validated.error }
  }
  const config = validated.config

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
      enabled: false, // operator enables intentionally after previewing
    })
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Couldn't save the agent." }
  }

  revalidatePath("/receptionist")
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

  revalidatePath("/receptionist")
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
  revalidatePath("/receptionist")
  revalidatePath("/approvals")
  return { ok: true, outcome }
}

export type ListAgentRunsResult =
  | { ok: true; runs: CustomAgentRunRow[] }
  | { ok: false; error: string }

export async function listAgentRuns(
  agentId: string
): Promise<ListAgentRunsResult> {
  try {
    await requireUser()
    const shop = await requireShop()
    const supabase = await createClient()
    const runs = await listAgentRunsForShop(supabase, {
      agentId,
      shopId: shop.id,
    })
    return { ok: true, runs }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Couldn't load activity.",
    }
  }
}

export type SetEnabledResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Enable/disable a custom agent. Enabled agents are picked up by the
 * scheduled-agents cron — both coded recipes and free-form plans.
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

  revalidatePath("/receptionist")
  return { ok: true }
}
