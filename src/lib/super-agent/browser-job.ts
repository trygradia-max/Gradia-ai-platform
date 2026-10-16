import { unavailableBrowserCheck, type BrowserCheckDetail } from "./browser"
import type { EmployeeBrief } from "./brief"
import type { SavedBrowserCheck } from "./browser-store"

export type BrowserStore = {
  draft(shopId: string, draftId: string): Promise<EmployeeBrief | null>
  check(shopId: string, checkId: string): Promise<SavedBrowserCheck | null>
  owns(shopId: string, userId: string): Promise<boolean>
  save(row: { id: string; shopId: string; draftId: string; detail: BrowserCheckDetail }): Promise<"saved" | "replay" | "conflict" | "failed">
}

export async function executeBrowserCheck(input: {
  shopId: string
  userId: string
  checkId: string
  draftId: string
  namedProviderIgnored: boolean
}, store: BrowserStore): Promise<{ ok: true; replayed: boolean; check: SavedBrowserCheck } | { ok: false; error: string }> {
  if (!await store.owns(input.shopId, input.userId)) return { ok: false, error: "Workspace access could not be verified." }
  const existing = await store.check(input.shopId, input.checkId)
  if (existing) {
    if (existing.draft_id !== input.draftId) return { ok: false, error: "This check already belongs to a different brief." }
    return { ok: true, replayed: true, check: existing }
  }
  const brief = await store.draft(input.shopId, input.draftId)
  if (!brief) return { ok: false, error: "That employee brief is not in this workspace." }
  if (!await store.owns(input.shopId, input.userId)) return { ok: false, error: "The check stopped because workspace access changed. Nothing new was saved." }
  const saved = await store.save({
    id: input.checkId, shopId: input.shopId, draftId: input.draftId, detail: unavailableBrowserCheck(input.namedProviderIgnored),
  })
  if (saved === "conflict") return { ok: false, error: "This check already belongs to a different brief." }
  if (saved === "failed") return { ok: false, error: "The check could not be saved. Retry this same check." }
  const row = await store.check(input.shopId, input.checkId)
  if (!row || row.draft_id !== input.draftId || row.detail.session_started || row.detail.credentials_stored || row.detail.local_machine_used) {
    return { ok: false, error: "The check could not be saved. Retry this same check." }
  }
  return { ok: true, replayed: saved === "replay", check: row }
}
