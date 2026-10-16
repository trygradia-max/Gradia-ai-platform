"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { employeeBriefSchema, employeeRequestSchema, type EmployeeBrief } from "@/lib/super-agent/brief"
import { planEmployee } from "@/lib/super-agent/planner"
import { loadShopCreditFields, precheckCredits, recordUsage } from "@/lib/credits"
import { getPricing, priceUsage } from "@/lib/pricing"
import { checkRateLimit } from "@/lib/rate-limit"

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
