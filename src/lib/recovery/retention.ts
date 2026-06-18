/**
 * Retention policy for Customer Recovery imports (P8 / NEXT-3,
 * GRADIA_CUSTOMER_RECOVERY_SPEC §1.2 — "delete raw uploads after extraction
 * completes; configurable retention, default 30 days"). The decision logic is
 * pure so the policy is unit-tested; the cron applies it (DB + storage).
 *
 * runExtraction already purges bodies the moment a job finishes. This is the
 * safety net for everything else: failed jobs, imports abandoned mid-run, and
 * any object that outlives the retention window.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** Default raw-body retention window. */
export const RETENTION_DAYS = 30
/** An in-progress job idle this long is treated as abandoned. */
export const STALE_HOURS = 6

export type RetentionJob = {
  id: string
  status: string
  created_at: string
  updated_at: string
}

export type RetentionPlan = {
  /** Stuck/abandoned in-progress jobs to mark failed. */
  toFail: string[]
  /** Jobs whose raw bodies should be purged now. */
  toPurge: string[]
}

/**
 * Decide what to clean up:
 *   - an in-progress job (estimating/extracting) idle past STALE_HOURS →
 *     mark failed AND purge,
 *   - a failed job → purge (no value in keeping its PII),
 *   - any job older than the retention window → purge (catch-all).
 * A fresh job awaiting the owner's confirm is left alone.
 */
export function planRetention(
  jobs: RetentionJob[],
  nowMs: number,
  opts?: { retentionDays?: number; staleHours?: number }
): RetentionPlan {
  const retentionCutoff = nowMs - (opts?.retentionDays ?? RETENTION_DAYS) * DAY_MS
  const staleCutoff = nowMs - (opts?.staleHours ?? STALE_HOURS) * HOUR_MS

  const toFail: string[] = []
  const toPurge = new Set<string>()

  for (const j of jobs) {
    const created = Date.parse(j.created_at)
    const updated = Date.parse(j.updated_at)
    const inProgress = j.status === "estimating" || j.status === "extracting"

    if (inProgress && !Number.isNaN(updated) && updated < staleCutoff) {
      toFail.push(j.id)
      toPurge.add(j.id)
      continue
    }
    if (j.status === "failed") {
      toPurge.add(j.id)
      continue
    }
    if (!Number.isNaN(created) && created < retentionCutoff) {
      toPurge.add(j.id)
    }
  }

  return { toFail, toPurge: [...toPurge] }
}
