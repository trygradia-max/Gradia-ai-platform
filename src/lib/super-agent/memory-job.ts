import type { EmployeeBrief } from "./brief"
import { memorySnapshot, type BusinessNote, type MemoryReadDetail } from "./memory"
import type { SavedMemoryRead } from "./memory-store"

export type MemoryStore = {
  draft(shopId: string, draftId: string): Promise<EmployeeBrief | null>
  read(shopId: string, readId: string): Promise<SavedMemoryRead | null>
  owns(shopId: string, userId: string): Promise<boolean>
  notes(shopId: string): Promise<{ ok: true; notes: BusinessNote[] } | { ok: false }>
  save(row: { id: string; shopId: string; draftId: string; detail: MemoryReadDetail }): Promise<"saved" | "replay" | "conflict" | "failed">
}

export async function executeMemoryRead(input: {
  shopId: string
  userId: string
  readId: string
  draftId: string
}, store: MemoryStore): Promise<{ ok: true; replayed: boolean; read: SavedMemoryRead } | { ok: false; error: string }> {
  if (!await store.owns(input.shopId, input.userId)) return { ok: false, error: "Workspace access could not be verified." }
  const existing = await store.read(input.shopId, input.readId)
  if (existing) {
    if (existing.draft_id !== input.draftId) return { ok: false, error: "This read already belongs to a different brief." }
    return { ok: true, replayed: true, read: existing }
  }
  const brief = await store.draft(input.shopId, input.draftId)
  if (!brief) return { ok: false, error: "That employee brief is not in this workspace." }
  const notes = await store.notes(input.shopId)
  if (!notes.ok) return { ok: false, error: "Saved business notes could not be read. Nothing new was saved." }
  if (!await store.owns(input.shopId, input.userId)) return { ok: false, error: "The read stopped because workspace access changed. Nothing new was saved." }
  const saved = await store.save({
    id: input.readId, shopId: input.shopId, draftId: input.draftId, detail: memorySnapshot(notes.notes),
  })
  if (saved === "conflict") return { ok: false, error: "This read already belongs to a different brief." }
  if (saved === "failed") return { ok: false, error: "The read could not be saved. Retry this same read." }
  const row = await store.read(input.shopId, input.readId)
  if (!row || row.draft_id !== input.draftId || row.detail.published || row.detail.lesson_created || row.detail.research_included) {
    return { ok: false, error: "The read could not be saved. Retry this same read." }
  }
  return { ok: true, replayed: saved === "replay", read: row }
}
