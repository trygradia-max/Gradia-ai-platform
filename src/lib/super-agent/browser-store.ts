import type { SupabaseClient } from "@supabase/supabase-js"
import { browserCheckDetailSchema, type BrowserCheckDetail } from "./browser"

export type SavedBrowserCheck = {
  id: string
  draft_id: string
  status: "unavailable"
  detail: BrowserCheckDetail
  created_at: string
}

type WriteError = { code?: string } | null
const duplicate = (error: WriteError) => error?.code === "23505"

function readCheckRow(data: { id?: unknown; draft_id?: unknown; status?: unknown; detail?: unknown; created_at?: unknown }): SavedBrowserCheck | null {
  const detail = browserCheckDetailSchema.safeParse(data.detail)
  if (data.status !== "unavailable" || !detail.success || typeof data.id !== "string" || typeof data.draft_id !== "string" || typeof data.created_at !== "string") return null
  return { id: data.id, draft_id: data.draft_id, status: "unavailable", detail: detail.data, created_at: data.created_at }
}

export async function readBrowserCheck(db: SupabaseClient, shopId: string, checkId: string): Promise<SavedBrowserCheck | null> {
  const { data, error } = await db.from("super_agent_browser_checks").select("id,draft_id,status,detail,created_at").eq("id", checkId).eq("shop_id", shopId).maybeSingle()
  if (error || !data) return null
  return readCheckRow(data)
}

export async function listBrowserChecks(db: SupabaseClient, shopId: string): Promise<{ checks: SavedBrowserCheck[]; failed: boolean }> {
  const { data, error } = await db.from("super_agent_browser_checks").select("id,draft_id,status,detail,created_at").eq("shop_id", shopId).order("created_at", { ascending: false }).limit(50)
  if (error) return { checks: [], failed: true }
  const checks: SavedBrowserCheck[] = []
  let failed = false
  for (const row of data ?? []) {
    const parsed = readCheckRow(row)
    if (parsed) checks.push(parsed)
    else failed = true
  }
  return { checks, failed }
}

export async function saveBrowserCheck(db: SupabaseClient, row: {
  id: string
  shopId: string
  draftId: string
  detail: BrowserCheckDetail
}): Promise<"saved" | "replay" | "conflict" | "failed"> {
  const detail = browserCheckDetailSchema.safeParse(row.detail)
  if (!detail.success) return "failed"
  const { error } = await db.from("super_agent_browser_checks").insert({
    id: row.id, shop_id: row.shopId, draft_id: row.draftId, status: "unavailable", provider: "none", detail: detail.data,
  })
  if (!error) return "saved"
  if (!duplicate(error)) return "failed"
  const existing = await readBrowserCheck(db, row.shopId, row.id)
  if (!existing) return "failed"
  return existing.draft_id === row.draftId ? "replay" : "conflict"
}
