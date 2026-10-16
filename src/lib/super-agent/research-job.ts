import type { EmployeeBrief } from "./brief"
import { runPublicResearch, type ResearchReport, type SavedResearchStatus } from "./research"
import type { SavedResearchRun } from "./research-store"
import type { PageTransport } from "./page-transport"

export type ResearchStore = {
  draft(shopId: string, draftId: string): Promise<EmployeeBrief | null>
  run(shopId: string, runId: string): Promise<SavedResearchRun | null>
  owns(shopId: string, userId: string): Promise<boolean>
  cancelled(shopId: string, runId: string): Promise<boolean>
  save(row: { id: string; shopId: string; draftId: string; status: SavedResearchStatus; report: ResearchReport; credits: number }): Promise<"saved" | "replay" | "conflict" | "failed">
}

export type ResearchRuntime = {
  now: () => number
  budgetMs?: number
  maxFetches?: number
  maxBytes?: number
  fetchTimeoutMs?: number
  resolve: (hostname: string) => Promise<string[]>
  transport: PageTransport
  planWithModel?: (brief: EmployeeBrief, urls: string[]) => Promise<{ urls: string[]; checks: import("./research").SeoCheck[] } | null>
}

export async function executeSavedResearch(input: {
  shopId: string
  userId: string
  runId: string
  draftId: string
  credits: number
  modelNote?: string | null
}, store: ResearchStore, runtime: ResearchRuntime): Promise<
  | { ok: true; replayed: boolean; run: SavedResearchRun }
  | { ok: false; error: string }
> {
  if (!await store.owns(input.shopId, input.userId)) return { ok: false, error: "Workspace access could not be verified." }
  const existing = await store.run(input.shopId, input.runId)
  if (existing) {
    if (existing.draft_id !== input.draftId) return { ok: false, error: "This run already belongs to a different brief." }
    return { ok: true, replayed: true, run: existing }
  }
  const brief = await store.draft(input.shopId, input.draftId)
  if (!brief) return { ok: false, error: "That employee brief is not in this workspace." }
  const result = await runPublicResearch(brief, {
    ...runtime,
    modelNote: input.modelNote,
    stillAuthorized: () => store.owns(input.shopId, input.userId),
    isCancelled: () => store.cancelled(input.shopId, input.runId),
  })
  if (result.status === "unauthorized" || !result.report) return { ok: false, error: "Research stopped because workspace access changed. Nothing new was saved." }
  const saved = await store.save({
    id: input.runId, shopId: input.shopId, draftId: input.draftId, status: result.status,
    report: result.report, credits: result.modelUsed ? input.credits : 0,
  })
  if (saved === "conflict") return { ok: false, error: "This run already belongs to a different brief." }
  if (saved === "failed") return { ok: false, error: "The result could not be saved. Retry this same run." }
  const row = await store.run(input.shopId, input.runId)
  if (!row || row.draft_id !== input.draftId) return { ok: false, error: "The result could not be saved. Retry this same run." }
  return { ok: true, replayed: saved === "replay", run: row }
}
