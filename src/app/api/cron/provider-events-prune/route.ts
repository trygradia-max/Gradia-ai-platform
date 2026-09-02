/**
 * provider_events pruning cron (P0-005A, ADR-001 C2). Runs daily (see
 * vercel.json). Deletes expired `completed` / `failed` idempotency receipts
 * in bounded SKIP LOCKED batches via `prune_provider_events`; `processing`
 * rows are never age-pruned. Tenant-blind by spec (time/status keyed) —
 * the only query is the RPC, which reads no request input.
 *
 * Vercel cron auth: `Authorization: Bearer <CRON_SECRET>`. Fails closed.
 * Failure direction: rows accumulate until the next run — safe.
 */

import { runCron } from "@/lib/cron-run"
import {
  formatPruneRunLog,
  pruneRunWarnings,
  runProviderEventPruning,
} from "@/lib/provider-events-retention"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

async function handle(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/provider-events-prune] CRON_SECRET not configured")
    return unauthorized()
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return unauthorized()
  }

  try {
    const summary = await runProviderEventPruning(createServiceClient())
    console.info(formatPruneRunLog(summary))
    for (const line of pruneRunWarnings(summary)) console.warn(line)
    return Response.json({
      ok: true,
      batches: summary.batches,
      completedPruned: summary.completedPruned,
      failedPruned: summary.failedPruned,
      expiredRemaining:
        summary.last.completed_expired_remaining + summary.last.failed_expired_remaining,
      oldestCompletedAt: summary.last.oldest_completed_at,
      oldestFailedAt: summary.last.oldest_failed_at,
      processingRows: summary.last.processing_rows,
      attemptsOverCap: summary.last.attempts_over_cap,
      oversizedMetadata: summary.last.oversized_metadata,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[cron/provider-events-prune] run failed:", message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

/** P0-012: every cron runs through one wrapper — heartbeat stamps + one ops alert on failure. */
export const GET = (request: Request) => runCron("provider-events-prune", request, handle)
