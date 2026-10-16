import type { SupabaseClient } from "@supabase/supabase-js"
import { employeeBriefSchema, type EmployeeBrief } from "./brief"
import { researchReportSchema, savedResearchStatusSchema, type ResearchReport, type SavedResearchStatus } from "./research"

export type SavedResearchRun = {
  id: string
  draft_id: string
  status: SavedResearchStatus
  report: ResearchReport
  credits: number
  created_at: string
}

type WriteError = { code?: string } | null
const duplicate = (error: WriteError) => error?.code === "23505"

export async function readEmployeeDraft(db: SupabaseClient, shopId: string, draftId: string): Promise<EmployeeBrief | null> {
  const { data, error } = await db.from("super_agent_employee_drafts").select("brief").eq("id", draftId).eq("shop_id", shopId).maybeSingle()
  if (error || !data) return null
  const brief = employeeBriefSchema.safeParse(data.brief)
  return brief.success ? brief.data : null
}

export async function readResearchRun(db: SupabaseClient, shopId: string, runId: string): Promise<SavedResearchRun | null> {
  const { data, error } = await db.from("super_agent_research_runs").select("id,draft_id,status,report,credits,created_at").eq("id", runId).eq("shop_id", shopId).maybeSingle()
  if (error || !data) return null
  const status = savedResearchStatusSchema.safeParse(data.status)
  const report = researchReportSchema.safeParse(data.report)
  if (!status.success || !report.success || typeof data.created_at !== "string") return null
  return { id: data.id, draft_id: data.draft_id, status: status.data, report: report.data, credits: Number(data.credits) || 0, created_at: data.created_at }
}

export async function listResearchRuns(db: SupabaseClient, shopId: string): Promise<{ runs: SavedResearchRun[]; failed: boolean }> {
  const { data, error } = await db.from("super_agent_research_runs").select("id,draft_id,status,report,credits,created_at").eq("shop_id", shopId).order("created_at", { ascending: false }).limit(50)
  if (error) return { runs: [], failed: true }
  const runs: SavedResearchRun[] = []
  let failed = false
  for (const row of data ?? []) {
    const parsed = readRunRow(row)
    if (parsed) runs.push(parsed)
    else failed = true
  }
  return { runs, failed }
}

function readRunRow(data: { id?: string; draft_id?: string; status?: unknown; report?: unknown; credits?: unknown; created_at?: unknown }): SavedResearchRun | null {
  const status = savedResearchStatusSchema.safeParse(data.status)
  const report = researchReportSchema.safeParse(data.report)
  if (!status.success || !report.success || typeof data.id !== "string" || typeof data.draft_id !== "string" || typeof data.created_at !== "string") return null
  return { id: data.id, draft_id: data.draft_id, status: status.data, report: report.data, credits: Number(data.credits) || 0, created_at: data.created_at }
}

export async function ownerStillHasShop(db: SupabaseClient, shopId: string, userId: string): Promise<boolean> {
  const { data, error } = await db.from("shops").select("id").eq("id", shopId).eq("owner_id", userId).maybeSingle()
  return !error && Boolean(data)
}

/** A cancel-flag read failure stops the run. Continuing without the flag would ignore a stop. */
export async function researchWasCancelled(db: SupabaseClient, shopId: string, runId: string): Promise<boolean> {
  const { data, error } = await db.from("super_agent_research_cancels").select("run_id").eq("run_id", runId).eq("shop_id", shopId).maybeSingle()
  if (error) return true
  return Boolean(data)
}

export async function requestResearchCancel(db: SupabaseClient, shopId: string, runId: string): Promise<"saved" | "replay" | "failed"> {
  const { error } = await db.from("super_agent_research_cancels").insert({ run_id: runId, shop_id: shopId })
  if (!error) return "saved"
  return duplicate(error) ? "replay" : "failed"
}

export async function saveResearchRun(db: SupabaseClient, row: {
  id: string
  shopId: string
  draftId: string
  status: SavedResearchStatus
  report: ResearchReport
  credits: number
}): Promise<"saved" | "replay" | "conflict" | "failed"> {
  const report = researchReportSchema.safeParse(row.report)
  const status = savedResearchStatusSchema.safeParse(row.status)
  if (!report.success || !status.success || row.credits < 0 || row.credits > 100) return "failed"
  const { error } = await db.from("super_agent_research_runs").insert({
    id: row.id, shop_id: row.shopId, draft_id: row.draftId, status: status.data, report: report.data, credits: row.credits,
  })
  if (!error) return "saved"
  if (!duplicate(error)) return "failed"
  const existing = await readResearchRun(db, row.shopId, row.id)
  if (!existing) return "failed"
  return existing.draft_id === row.draftId ? "replay" : "conflict"
}
