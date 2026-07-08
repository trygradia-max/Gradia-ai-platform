/**
 * Nightly customer-lifecycle derivation (CRM C1, spec §C1.3) — code, not LLM.
 *
 * Rule (locked by tests): most recent service evidence <180 days → `active`;
 * 180–365 days silent → `at_risk`; >365 days → `lapsed`. "Service evidence"
 * is the latest of last_service_at / last_visit_at / last_transaction_at —
 * the same best-evidence posture as the C1 migration backfill.
 *
 * Deliberate carve-outs (documented, extend in C5+ if needed):
 * - No service evidence at all → lifecycle unchanged (nothing to derive from;
 *   a `lead` stays a lead until they're actually serviced).
 * - `maintenance` is owner/plan-managed — recency never overrides it.
 * - `won_back` is preserved while the win-back service is still fresh
 *   (<180 days) so revenue attribution (C8) keeps its meaning; after that,
 *   normal recency rules apply.
 *
 * NOT wired into vercel.json — a new cron needs founder sign-off (overnight
 * run 2026-07-08 rail). The future nightly cron should call
 * runLifecycleDerivation with the service-role client. Pre-C1-migration DBs
 * are tolerated: the runner detects the missing `lifecycle` column and
 * no-ops with a reason instead of throwing.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { CustomerLifecycle } from "@/lib/types/database"

const DAY_MS = 24 * 60 * 60 * 1000
/** <180 days serviced = active. */
export const ACTIVE_WITHIN_DAYS = 180
/** 180–365 days silent = at_risk; beyond = lapsed. */
export const LAPSED_AFTER_DAYS = 365

export type LifecycleEvidence = {
  last_service_at: string | null
  last_visit_at: string | null
  last_transaction_at: string | null
}

/** Latest usable service-evidence timestamp in ms, or null. */
export function lastServiceEvidenceMs(e: LifecycleEvidence): number | null {
  const times = [e.last_service_at, e.last_visit_at, e.last_transaction_at]
    .map((iso) => (iso ? Date.parse(iso) : Number.NaN))
    .filter((t) => Number.isFinite(t))
  return times.length ? Math.max(...times) : null
}

/** Pure: the derived lifecycle for one customer. Returns the CURRENT value
 *  when nothing should change (callers only write actual transitions). */
export function deriveLifecycle(
  current: CustomerLifecycle,
  evidence: LifecycleEvidence,
  nowMs: number
): CustomerLifecycle {
  if (current === "maintenance") return current

  const lastMs = lastServiceEvidenceMs(evidence)
  if (lastMs === null) return current

  const days = (nowMs - lastMs) / DAY_MS
  if (days < ACTIVE_WITHIN_DAYS) {
    // Fresh service: won_back keeps its label for attribution; everyone
    // else (lead included — they've now been serviced) becomes active.
    return current === "won_back" ? current : "active"
  }
  if (days < LAPSED_AFTER_DAYS) return "at_risk"
  return "lapsed"
}

export type LifecycleRunResult = {
  scanned: number
  updated: number
  /** Set when the run couldn't execute (e.g. C1 migration not applied). */
  skipped_reason?: string
}

type LifecycleRow = LifecycleEvidence & {
  id: string
  lifecycle: CustomerLifecycle
}

const PAGE_SIZE = 1000

/**
 * Cron-safe runner: derive + persist lifecycle for every customer (optionally
 * one shop). Idempotent — re-running changes nothing new. Batches writes by
 * target lifecycle, so a full page costs at most a handful of UPDATEs.
 */
export async function runLifecycleDerivation(
  supabase: SupabaseClient,
  opts: { shopId?: string; now?: Date } = {}
): Promise<LifecycleRunResult> {
  const nowMs = (opts.now ?? new Date()).getTime()
  let scanned = 0
  let updated = 0

  for (let page = 0; ; page++) {
    let q = supabase
      .from("customers")
      .select(
        "id, lifecycle, last_service_at, last_visit_at, last_transaction_at"
      )
      .order("id", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    if (opts.shopId) q = q.eq("shop_id", opts.shopId)

    const { data, error } = await q
    if (error) {
      // Pre-C1-migration DB (no lifecycle column) or transient failure —
      // never throw out of a cron; report and stop.
      return {
        scanned,
        updated,
        skipped_reason: `lifecycle derivation skipped: ${error.message}`,
      }
    }
    const rows = (data as LifecycleRow[] | null) ?? []
    scanned += rows.length

    const transitions = new Map<CustomerLifecycle, string[]>()
    for (const row of rows) {
      const next = deriveLifecycle(row.lifecycle, row, nowMs)
      if (next !== row.lifecycle) {
        const ids = transitions.get(next) ?? []
        ids.push(row.id)
        transitions.set(next, ids)
      }
    }

    for (const [lifecycle, ids] of transitions) {
      const { error: updateErr } = await supabase
        .from("customers")
        .update({ lifecycle })
        .in("id", ids)
      if (updateErr) {
        console.error("[lifecycle] batch update failed:", updateErr)
        continue
      }
      updated += ids.length
    }

    if (rows.length < PAGE_SIZE) break
  }

  return { scanned, updated }
}
