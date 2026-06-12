"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  previewFreeformPlan,
  type FreeformPreview,
} from "@/lib/agent-audience"
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
  config: AgentConfig
): Promise<PreviewAgentResult> {
  await requireUser()
  const shopCtx = await requireShop()
  if (!FEATURES.freeformPlanner) {
    return { ok: false, error: "Free-form preview isn't enabled yet." }
  }
  if (!config?.freeform) {
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
      enabled: false, // operator enables intentionally after previewing
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

  revalidatePath("/agents")
  return { ok: true }
}
