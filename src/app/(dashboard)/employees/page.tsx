import { notFound } from "next/navigation"
import { EmployeeBuilder } from "@/components/gradia/employee-builder"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { employeeBriefSchema, type EmployeeDraft } from "@/lib/super-agent/brief"
import { listBrowserChecks } from "@/lib/super-agent/browser-store"
import { listResearchRuns } from "@/lib/super-agent/research-store"
import { getPricing, priceUsage } from "@/lib/pricing"

export const dynamic = "force-dynamic"

export default async function EmployeesPage() {
  if (process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT !== "true") notFound()
  await requireUser()
  const shop = await requireShop()
  const db = await createClient()
  const { data, error } = await db.from("super_agent_employee_drafts").select("id,brief,created_at").eq("shop_id", shop.id).order("created_at", { ascending: false }).limit(50)
  const drafts: EmployeeDraft[] = []
  let invalid = false
  for (const row of data ?? []) {
    const brief = employeeBriefSchema.safeParse(row.brief)
    if (brief.success) drafts.push({ id: row.id, created_at: row.created_at, brief: brief.data })
    else invalid = true
  }
  const planningEnabled = process.env.GRADIA_SUPER_AGENT_PLANNING === "true"
  const researchEnabled = process.env.GRADIA_SUPER_AGENT_RESEARCH === "true"
  const browserEnabled = process.env.GRADIA_SUPER_AGENT_BROWSER === "true"
  const planningCredits = planningEnabled ? priceUsage(await getPricing(db), "agentic_plan", 1).credits : null
  const research = researchEnabled ? await listResearchRuns(db, shop.id) : { runs: [], failed: false }
  const browser = browserEnabled ? await listBrowserChecks(db, shop.id) : { checks: [], failed: false }
  return <div className="mx-auto max-w-6xl space-y-8"><header className="space-y-3"><p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Gradia Super Agent · Early access</p><h1 className="text-3xl font-semibold tracking-tight">Build your digital employee</h1><p className="max-w-2xl text-muted-foreground">Give Gradia a job, tell it what matters, and decide what a good result looks like.{researchEnabled ? " When a brief is saved, you can run a public-page research check." : ""}</p></header><EmployeeBuilder drafts={drafts} runs={research.runs} loadFailed={Boolean(error) || invalid} runLoadFailed={research.failed} planningEnabled={planningEnabled} planningCredits={planningCredits} researchEnabled={researchEnabled} browserEnabled={browserEnabled} browserChecks={browser.checks} browserLoadFailed={browser.failed} /></div>
}
