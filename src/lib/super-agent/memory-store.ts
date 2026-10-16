import type { SupabaseClient } from "@supabase/supabase-js"
import { memoryReadDetailSchema, type MemoryReadDetail } from "./memory"

export type SavedMemoryRead = {
  id: string
  draft_id: string
  detail: MemoryReadDetail
  created_at: string
}

type WriteError = { code?: string } | null
const duplicate = (error: WriteError) => error?.code === "23505"

function readRow(data: { id?: unknown; draft_id?: unknown; detail?: unknown; created_at?: unknown }): SavedMemoryRead | null {
  const detail = memoryReadDetailSchema.safeParse(data.detail)
  if (!detail.success || typeof data.id !== "string" || typeof data.draft_id !== "string" || typeof data.created_at !== "string") return null
  return { id: data.id, draft_id: data.draft_id, detail: detail.data, created_at: data.created_at }
}

export async function readMemoryRead(db: SupabaseClient, shopId: string, readId: string): Promise<SavedMemoryRead | null> {
  const { data, error } = await db.from("super_agent_memory_reads").select("id,draft_id,detail,created_at").eq("id", readId).eq("shop_id", shopId).maybeSingle()
  if (error || !data) return null
  return readRow(data)
}

export async function listMemoryReads(db: SupabaseClient, shopId: string): Promise<{ reads: SavedMemoryRead[]; failed: boolean }> {
  const { data, error } = await db.from("super_agent_memory_reads").select("id,draft_id,detail,created_at").eq("shop_id", shopId).order("created_at", { ascending: false }).limit(50)
  if (error) return { reads: [], failed: true }
  const reads: SavedMemoryRead[] = []
  let failed = false
  for (const row of data ?? []) {
    const parsed = readRow(row)
    if (parsed) reads.push(parsed)
    else failed = true
  }
  return { reads, failed }
}

export async function saveMemoryRead(db: SupabaseClient, row: {
  id: string
  shopId: string
  draftId: string
  detail: MemoryReadDetail
}): Promise<"saved" | "replay" | "conflict" | "failed"> {
  const detail = memoryReadDetailSchema.safeParse(row.detail)
  if (!detail.success || detail.data.published || detail.data.lesson_created || detail.data.research_included) return "failed"
  const { error } = await db.from("super_agent_memory_reads").insert({
    id: row.id, shop_id: row.shopId, draft_id: row.draftId, detail: detail.data,
  })
  if (!error) return "saved"
  if (!duplicate(error)) return "failed"
  const existing = await readMemoryRead(db, row.shopId, row.id)
  if (!existing) return "failed"
  return existing.draft_id === row.draftId ? "replay" : "conflict"
}
