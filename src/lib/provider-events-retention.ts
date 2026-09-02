/**
 * provider_events retention (P0-005A, ADR-001 condition C2 follow-up).
 *
 * Bounds the growth of the idempotency claim table without touching claim
 * semantics (`provider-events.ts` is untouched on purpose). The database
 * function `prune_provider_events` (migration 20260901120000) does the
 * work: one bounded, oldest-first, `FOR UPDATE SKIP LOCKED` delete per
 * terminal status, so concurrent runs take disjoint rows and never error.
 *
 * Policy (mirrored as hard floors inside the SQL function):
 *   completed  → 30 days   failed → 90 days   processing → never by age
 * The floor (7 days) sits above every provider's webhook retry horizon
 * (Stripe ≈ 3 days is the longest), so a pruned receipt can no longer be
 * re-delivered by its provider — the accepted retention tradeoff. Lowering
 * the constants below the floor has no effect; the SQL clamps.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export const PROVIDER_EVENT_RETENTION = {
  /** Days a `completed` receipt survives. */
  completedDays: 30,
  /** Days a `failed` receipt survives (observability trail until P0-012). */
  failedDays: 90,
  /** Hard floor enforced in `prune_provider_events` — never below this. */
  floorDays: 7,
  /** Rows per status per RPC call. Small enough to never hold locks long. */
  batchSize: 5000,
  /** Upper bound on RPC calls per cron run (a run can never spin forever). */
  maxBatchesPerRun: 10,
} as const

/** One `prune_provider_events` call, as returned by Postgres. */
export type PruneBatchReport = {
  completed_pruned: number
  failed_pruned: number
  completed_expired_remaining: number
  failed_expired_remaining: number
  oldest_completed_at: string | null
  oldest_failed_at: string | null
  processing_rows: number
  attempts_over_cap: number
  oversized_metadata: number
  completed_retention_days: number
  failed_retention_days: number
  batch_size: number
}

export type PruneRunSummary = {
  batches: number
  completedPruned: number
  failedPruned: number
  /** State after the last batch — the backlog the next run picks up. */
  last: PruneBatchReport
}

export type PruneOptions = {
  completedDays?: number
  failedDays?: number
  batchSize?: number
  maxBatches?: number
}

/** Exactly one bounded batch. Throws on a database error (fail loud —
 *  rows accumulating is the safe direction; the next run catches up). */
export async function pruneProviderEventsBatch(
  supabase: SupabaseClient,
  opts: PruneOptions = {}
): Promise<PruneBatchReport> {
  const { data, error } = await supabase.rpc("prune_provider_events", {
    p_completed_retention_days: opts.completedDays ?? PROVIDER_EVENT_RETENTION.completedDays,
    p_failed_retention_days: opts.failedDays ?? PROVIDER_EVENT_RETENTION.failedDays,
    p_batch_size: opts.batchSize ?? PROVIDER_EVENT_RETENTION.batchSize,
  })
  if (error) {
    throw new Error(`[provider-events-retention] prune failed: ${error.message}`)
  }
  return data as PruneBatchReport
}

/**
 * A full cron run: repeat batches while the previous one was full, up to
 * `maxBatches`. Idempotent and overlap-safe by construction of the SQL
 * (SKIP LOCKED + stable ordering) — two runs racing simply split the work.
 */
export async function runProviderEventPruning(
  supabase: SupabaseClient,
  opts: PruneOptions = {}
): Promise<PruneRunSummary> {
  const batchSize = opts.batchSize ?? PROVIDER_EVENT_RETENTION.batchSize
  const maxBatches = Math.max(1, opts.maxBatches ?? PROVIDER_EVENT_RETENTION.maxBatchesPerRun)
  let completedPruned = 0
  let failedPruned = 0
  let batches = 0
  let last: PruneBatchReport | null = null
  while (batches < maxBatches) {
    const report = await pruneProviderEventsBatch(supabase, { ...opts, batchSize })
    batches += 1
    completedPruned += report.completed_pruned
    failedPruned += report.failed_pruned
    last = report
    const full =
      report.completed_pruned >= report.batch_size || report.failed_pruned >= report.batch_size
    if (!full) break
  }
  // `last` is always set: the loop body runs at least once (maxBatches ≥ 1).
  return { batches, completedPruned, failedPruned, last: last as PruneBatchReport }
}

/** The one info line per run (counts + oldest remaining) — P0-012's feed. */
export function formatPruneRunLog(summary: PruneRunSummary): string {
  const l = summary.last
  return (
    `[cron/provider-events-prune] batches=${summary.batches} ` +
    `completed_pruned=${summary.completedPruned} failed_pruned=${summary.failedPruned} ` +
    `expired_remaining=${l.completed_expired_remaining + l.failed_expired_remaining} ` +
    `oldest_completed_at=${l.oldest_completed_at ?? "none"} ` +
    `oldest_failed_at=${l.oldest_failed_at ?? "none"} ` +
    `processing_rows=${l.processing_rows} ` +
    `retention=${l.completed_retention_days}d/${l.failed_retention_days}d batch=${l.batch_size}`
  )
}

/** Hardening warnings from the P0-005 close (attempt runaway / metadata
 *  bloat) — surfaced, not enforced, in this ticket. */
export function pruneRunWarnings(summary: PruneRunSummary): string[] {
  const l = summary.last
  const warnings: string[] = []
  if (l.attempts_over_cap > 0) {
    warnings.push(
      `[cron/provider-events-prune] WARN ${l.attempts_over_cap} claim(s) exceed 25 attempts — a provider is retrying an event that keeps failing`
    )
  }
  if (l.oversized_metadata > 0) {
    warnings.push(
      `[cron/provider-events-prune] WARN ${l.oversized_metadata} claim(s) carry >4KB metadata — a caller is storing more than safe debugging keys`
    )
  }
  return warnings
}
