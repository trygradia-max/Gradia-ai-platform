"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { executeMemoryRead } from "@/lib/super-agent/memory-job"
import { readMemoryRead, saveMemoryRead, type SavedMemoryRead } from "@/lib/super-agent/memory-store"
import type { BusinessNote } from "@/lib/super-agent/memory"
import { ownerStillHasShop, readEmployeeDraft } from "@/lib/super-agent/research-store"
import { checkRateLimit } from "@/lib/rate-limit"
import type { SupabaseClient } from "@supabase/supabase-js"

async function readBusinessNotes(db: SupabaseClient, shopId: string): Promise<{ ok: true; notes: BusinessNote[] } | { ok: false }> {
  const { data, error } = await db.from("shop_knowledge").select("source_name, content").eq("shop_id", shopId).order("created_at", { ascending: false }).limit(8)
  if (error || !data) return { ok: false }
  const notes: BusinessNote[] = []
  for (const row of data) {
    if (typeof row.source_name === "string" && typeof row.content === "string") notes.push({ source_name: row.source_name, content: row.content })
  }
  return { ok: true, notes }
}

function memoryStore(db: SupabaseClient) {
  return {
    draft: (shopId: string, draftId: string) => readEmployeeDraft(db, shopId, draftId),
    read: (shopId: string, readId: string) => readMemoryRead(db, shopId, readId),
    owns: (shopId: string, userId: string) => ownerStillHasShop(db, shopId, userId),
    notes: (shopId: string) => readBusinessNotes(db, shopId),
    save: (row: Parameters<typeof saveMemoryRead>[1]) => saveMemoryRead(db, row),
  }
}

export async function readEmployeeMemory(input: unknown): Promise<{ ok: true; replayed: boolean; read: SavedMemoryRead } | { ok: false; error: string }> {
  if (process.env.NEXT_PUBLIC_GRADIA_SUPER_AGENT !== "true" || process.env.GRADIA_SUPER_AGENT_MEMORY !== "true") {
    return { ok: false, error: "Business-note reads are not enabled here yet." }
  }
  const parsed = z.object({ id: z.uuid(), draftId: z.uuid() }).strict().safeParse(input)
  if (!parsed.success) return { ok: false, error: "This business-note read could not be started." }
  const user = await requireUser()
  const shop = await requireShop()
  if (!(await checkRateLimit(shop.id, "agent_chat")).allowed) return { ok: false, error: "Please wait a moment before reading notes again." }
  const db = await createClient()
  const result = await executeMemoryRead({
    shopId: shop.id, userId: user.id, readId: parsed.data.id, draftId: parsed.data.draftId,
  }, memoryStore(db))
  if (result.ok) revalidatePath("/employees")
  return result
}
