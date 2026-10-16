"use server"

import { lookup } from "node:dns/promises"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { employeeBriefSchema, employeeRequestSchema, type EmployeeBrief } from "@/lib/super-agent/brief"
import { planEmployee } from "@/lib/super-agent/planner"
import { nodePageTransport } from "@/lib/super-agent/page-transport"
import { MODEL_SKIPPED_NOTE, RESEARCH_LIMITS } from "@/lib/super-agent/research"
import { executeSavedResearch } from "@/lib/super-agent/research-job"
import { planResearchSteps } from "@/lib/super-agent/research-model"
import { ownerStillHasShop, readResearchRun, requestResearchCancel, researchWasCancelled, readEmployeeDraft, saveResearchRun, type SavedResearchRun } from "@/lib/super-agent/research-store"
import { loadShopCreditFields, precheckCredits, recordUsage } from "@/lib/credits"
import { getPricing, priceUsage } from "@/lib/pricing"
import { checkRateLimit } from "@/lib/rate-limit"
import type { SupabaseClient } from "@supabase/supabase-js"

function researchStore(db: SupabaseClient) {
  return {
    draft: (shopId: string, draftId: string) => readEmployeeDraft(db, shopId, draftId),
    run: (shopId: string, runId: string) => readResearchRun(db, shopId, runId),
    owns: (shopId: string, userId: string) => ownerStillHasShop(db, shopId, userId),
    cancelled: (shopId: string, runId: string) => researchWasCancelled(db, shopId, runId),
    save: (row: Parameters<typeof saveResearchRun>[1]) => saveResearchRun(db, row),
  }
}

function redactResearchContext(value: string): string {
  return value.replace(/\b(?:sk|pk)_[A-Za-z0-9]{8,}\b/g, "[removed]").replace(/\b(?:password|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "[removed]")
}

export async function prepareEmployee(input: unknown): Promise<{ ok: true; brief: EmployeeBrief } | { ok: false; error: string }> {
  if (process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT !== "true" || process.env.GRADIA_SUPER_AGENT_PLANNING !== "true") return { ok: false, error: "AI setup is not enabled here yet. You can write and save the brief yourself." }
  const request = employeeRequestSchema.safeParse(input)
  if (!request.success) return { ok: false, error: "Describe the job in 10–2,000 characters and keep business context under 3,000 characters." }
  await requireUser()
  const shop = await requireShop()
  const db = await createClient()
  const fields = await loadShopCreditFields(db, shop.id)
  if (!fields) return { ok: false, error: "Workspace access could not be verified." }
  const price = priceUsage(await getPricing(db), "agentic_plan", 1)
  const budget = await precheckCredits(db, fields, price.credits)
  if (!budget.ok) return { ok: false, error: "There are not enough credits to prepare this brief. You can still write it yourself." }
  if (!(await checkRateLimit(shop.id, "agent_chat")).allowed) return { ok: false, error: "Please wait a moment before preparing another brief." }
  try {
    const brief = await planEmployee(request.data)
    await recordUsage(db, shop.id, "agentic_plan", { credits: price.credits, wholesaleCost: price.wholesale_cost, retailCost: price.retail_cost })
    return { ok: true, brief }
  } catch {
    return { ok: false, error: "Gradia couldn't prepare the brief. You can keep editing it yourself. No job has started." }
  }
}

export async function saveEmployeeDraft(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT !== "true") return { ok: false, error: "Digital employees are not enabled here yet." }
  const parsed = z.object({ id: z.uuid(), brief: employeeBriefSchema }).strict().safeParse(input)
  if (!parsed.success) return { ok: false, error: "Check the job name, goal, output and steps before saving." }
  await requireUser()
  const shop = await requireShop()
  const db = await createClient()
  const { error } = await db.from("super_agent_employee_drafts").insert({ ...parsed.data, shop_id: shop.id })
  if (error) {
    // An uncertain request retries the identical ID and payload, never a new draft.
    const existing = await db.from("super_agent_employee_drafts").select("brief").eq("id", parsed.data.id).eq("shop_id", shop.id).maybeSingle()
    const brief = employeeBriefSchema.safeParse(existing.data?.brief)
    if (!brief.success || JSON.stringify(brief.data) !== JSON.stringify(parsed.data.brief)) {
      return { ok: false, error: "Save could not be confirmed. Retry this same brief or reload to check your saved employees." }
    }
  }
  revalidatePath("/employees")
  return { ok: true }
}

const researchRunInput = z.object({ id: z.uuid(), draftId: z.uuid() }).strict()

export async function runEmployeeResearch(input: unknown): Promise<{ ok: true; replayed: boolean; run: SavedResearchRun } | { ok: false; error: string }> {
  if (process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT !== "true" || process.env.GRADIA_SUPER_AGENT_RESEARCH !== "true") return { ok: false, error: "Research runs are not enabled here yet." }
  const parsed = researchRunInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: "This research run could not be started." }
  const user = await requireUser()
  const shop = await requireShop()
  if (!(await checkRateLimit(shop.id, "agent_chat")).allowed) return { ok: false, error: "Please wait a moment before running research again." }
  const db = await createClient()
  const modelRequested = process.env.GRADIA_SUPER_AGENT_RESEARCH_MODEL === "true" && Boolean(process.env.ANTHROPIC_API_KEY?.trim())
  let credits = 0
  let modelNote: string | null = null
  let planWithModel: ((brief: EmployeeBrief, urls: string[]) => ReturnType<typeof planResearchSteps>) | undefined
  if (modelRequested) {
    const fields = await loadShopCreditFields(db, shop.id)
    const price = priceUsage(await getPricing(db), "agentic_plan", 1)
    const budget = fields ? await precheckCredits(db, fields, price.credits) : { ok: false as const }
    if (!budget.ok) modelNote = MODEL_SKIPPED_NOTE
    else {
      credits = price.credits
      planWithModel = (brief, urls) => planResearchSteps({ goal: brief.goal, context: redactResearchContext(brief.business_context), deliverable: brief.deliverable, urls })
    }
  }
  const result = await executeSavedResearch({
    shopId: shop.id, userId: user.id, runId: parsed.data.id, draftId: parsed.data.draftId, credits, modelNote,
  }, researchStore(db), {
    now: () => Date.now(),
    ...RESEARCH_LIMITS,
    resolve: async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(record => record.address),
    transport: nodePageTransport,
    planWithModel,
  })
  // vendorRef makes a replayed charge a no-op, including a retry after a lost response.
  if (result.ok && result.run.credits > 0) {
    const price = priceUsage(await getPricing(db), "agentic_plan", 1)
    await recordUsage(db, shop.id, "agentic_plan", {
      credits: result.run.credits, wholesaleCost: price.wholesale_cost, retailCost: price.retail_cost,
      vendorRef: `research-plan:${result.run.id}`, refId: result.run.id,
    })
  }
  if (result.ok) revalidatePath("/employees")
  return result.ok ? { ok: true, replayed: result.replayed, run: result.run } : result
}

export async function cancelEmployeeResearch(input: unknown): Promise<{ ok: true; state: "requested" | "already_finished" } | { ok: false; error: string }> {
  if (process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT !== "true" || process.env.GRADIA_SUPER_AGENT_RESEARCH !== "true") return { ok: false, error: "Research runs are not enabled here yet." }
  const parsed = z.object({ id: z.uuid() }).strict().safeParse(input)
  if (!parsed.success) return { ok: false, error: "This run could not be stopped." }
  const user = await requireUser()
  const shop = await requireShop()
  const db = await createClient()
  if (!await ownerStillHasShop(db, shop.id, user.id)) return { ok: false, error: "Workspace access could not be verified." }
  const existing = await readResearchRun(db, shop.id, parsed.data.id)
  const cancel = await requestResearchCancel(db, shop.id, parsed.data.id)
  if (cancel === "failed") return { ok: false, error: "Stop could not be saved. The run may still finish." }
  revalidatePath("/employees")
  return { ok: true, state: existing ? "already_finished" : "requested" }
}
