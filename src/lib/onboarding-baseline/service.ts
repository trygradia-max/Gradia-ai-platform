import type { SupabaseClient } from "@supabase/supabase-js"
import { BASELINE_CATALOG_VERSION } from "./catalog"
import type { BaselineReadResult, ComparisonDto, MeasurementRow, StartingPointDto } from "./dto"
import { buildComparison, buildStartingPoint } from "./report"
import { validateBaselineAnswers, type Issue } from "./validate"

type Db = Pick<SupabaseClient, "rpc">
export type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: "forbidden" | "conflict" | "invalid" | "unavailable"; issues?: Issue[] }

const FORBIDDEN = "42501", CONFLICT = "PT409", INVALID = "22023"
function failure(error: { code?: string }): { ok: false; code: "forbidden" | "conflict" | "invalid" | "unavailable" } {
  const code = error.code === FORBIDDEN ? "forbidden" : error.code === CONFLICT ? "conflict" : error.code === INVALID ? "invalid" : "unavailable"
  return { ok: false, code }
}

/** Any failure to read is `unavailable`/`forbidden`; a report is never built from missing data. */
async function load(db: Db, shopId: string, revision?: number): Promise<{ ok: true; data: BaselineReadResult } | { ok: false; code: "forbidden" | "unavailable" }> {
  try {
    const { data, error } = await db.rpc("baseline_read", { p_shop: shopId, p_revision: revision ?? null })
    if (error) return { ok: false, code: error.code === FORBIDDEN ? "forbidden" : "unavailable" }
    if (!data || typeof data !== "object" || !("role" in data)) return { ok: false, code: "unavailable" }
    return { ok: true, data: data as BaselineReadResult }
  } catch {
    return { ok: false, code: "unavailable" }
  }
}

export async function readStartingPoint(db: Db, shopId: string): Promise<StartingPointDto> {
  const r = await load(db, shopId)
  if (!r.ok) return { status: r.code }
  try { return buildStartingPoint(r.data) } catch { return { status: "unavailable" } }
}

/** Compares the pinned baseline revision (default: the current pointer) with an exact observation window. */
export async function readComparison(db: Db, shopId: string, window: { start: string; end: string }, revision?: number): Promise<ComparisonDto> {
  const r = await load(db, shopId, revision)
  if (!r.ok) return { status: r.code }
  if (!r.data.revision) return { status: "not_started" }
  try {
    const { data, error } = await db.rpc("baseline_read_window", { p_shop: shopId, p_window_start: window.start, p_window_end: window.end })
    if (error) return { status: error.code === FORBIDDEN ? "forbidden" : "unavailable" }
    if (!Array.isArray(data)) return { status: "unavailable" }
    return buildComparison(r.data, data as MeasurementRow[], window)
  } catch {
    return { status: "unavailable" }
  }
}

export async function saveDraft(db: Db, input: { shopId: string; answers: unknown; expectedDraftVersion: number | null }): Promise<CommandResult<{ draftVersion: number }>> {
  const issues = validateBaselineAnswers(input.answers, { complete: false })
  if (issues.length) return { ok: false, code: "invalid", issues }
  try {
    const { data, error } = await db.rpc("baseline_save_draft", {
      p_shop: input.shopId, p_answers: input.answers, p_expected_draft_version: input.expectedDraftVersion, p_catalog_version: BASELINE_CATALOG_VERSION,
    })
    if (error) return failure(error)
    return { ok: true, data: { draftVersion: (data as { draft_version: number }).draft_version } }
  } catch {
    return { ok: false, code: "unavailable" }
  }
}

export async function submitBaseline(db: Db, input: {
  shopId: string; answers: unknown; periodStart: string; periodEnd: string
  expectedBaseline: number | null; expectedDraftVersion: number | null; evidence?: string[]
}): Promise<CommandResult<{ revision: number; kind: "submitted" | "superseded"; supersedesRevision: number | null }>> {
  const issues = validateBaselineAnswers(input.answers, { complete: true })
  if (issues.length) return { ok: false, code: "invalid", issues }
  try {
    const { data, error } = await db.rpc("baseline_submit", {
      p_shop: input.shopId, p_answers: input.answers, p_period_start: input.periodStart, p_period_end: input.periodEnd,
      p_expected_baseline: input.expectedBaseline, p_expected_draft_version: input.expectedDraftVersion,
      p_evidence: input.evidence ?? [], p_catalog_version: BASELINE_CATALOG_VERSION,
    })
    if (error) return failure(error)
    const d = data as { revision: number; kind: "submitted" | "superseded"; supersedes_revision: number | null }
    return { ok: true, data: { revision: d.revision, kind: d.kind, supersedesRevision: d.supersedes_revision } }
  } catch {
    return { ok: false, code: "unavailable" }
  }
}
