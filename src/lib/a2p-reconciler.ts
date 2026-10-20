/**
 * Held A2P status reconciler (October 20 brief, priority 2).
 *
 * Refreshes registrations that are with carriers or approved (brand_pending,
 * campaign_pending, approved, suspended) without anyone clicking Check status,
 * so UI polling isn't the only thing keeping approval evidence fresh.
 *
 * - Off unless A2P_RECONCILER_ENABLED is exactly "true". Off, it reads nothing.
 *   No cron, schedule or Event Stream calls it; the release lane decides that.
 * - Bounded: at most `batch` registrations per run (default 25, never more
 *   than 100), oldest next_check_at first.
 * - Idempotent and single-flight per shop: each refresh is syncA2pStatus,
 *   which takes the registration's claim before any provider call and uses
 *   only that shop's own subaccount credentials. A run that loses the claim
 *   calls nothing for that shop and leaves its schedule alone.
 * - Backoff: a failed check doubles the wait from 5 minutes, capped. A
 *   successful one resets the count.
 *
 * Freshness relationship: every interval and the backoff cap are at most a
 * quarter of the evidence maximum age (a2p-evidence.ts, 72 hours by default),
 * so a scheduled reconciler gets several tries to renew evidence before the
 * send gate closes as "check overdue". The release lane must schedule it at
 * least that often for this to hold.
 */
import type { SupabaseClient } from "@supabase/supabase-js"

import { a2pEvidenceMaxAgeHours } from "@/lib/a2p-evidence"
import { syncA2pStatus } from "@/lib/telephony-provider"
import type { A2pRegistrationRow, ShopRow } from "@/lib/types/database"

type Env = Record<string, string | undefined>

export const A2P_RECONCILE_STATUSES = ["brand_pending", "campaign_pending", "approved", "suspended"] as const
const DEFAULT_BATCH = 25
const MAX_BATCH = 100
const MINUTE = 60_000

/** The schedule, all derived from the evidence maximum age. */
export function a2pReconcileSchedule(env: Env = process.env) {
  const quarterOfMaxAge = (a2pEvidenceMaxAgeHours(env) * 60 * MINUTE) / 4
  return {
    /** After a successful check of a pending registration. */
    pendingIntervalMs: Math.min(60 * MINUTE, quarterOfMaxAge),
    /** After a successful check of an approved or suspended registration. */
    settledIntervalMs: Math.min(6 * 60 * MINUTE, quarterOfMaxAge),
    /** First retry after a failed check; doubles per consecutive failure. */
    backoffBaseMs: 5 * MINUTE,
    backoffCapMs: Math.min(6 * 60 * MINUTE, quarterOfMaxAge),
  }
}

/** Wait before the next check after `failures` consecutive failed checks (1 or more). */
export function a2pBackoffMs(failures: number, env: Env = process.env): number {
  const { backoffBaseMs, backoffCapMs } = a2pReconcileSchedule(env)
  return Math.min(backoffBaseMs * 2 ** Math.max(0, failures - 1), backoffCapMs)
}

export function a2pReconcilerEnabled(env: Env = process.env): boolean {
  return env.A2P_RECONCILER_ENABLED?.trim() === "true"
}

function batchSize(requested: number | undefined, env: Env): number {
  const raw = requested ?? Number(env.A2P_RECONCILE_BATCH?.trim())
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_BATCH) : DEFAULT_BATCH
}

export type A2pReconcileSummary =
  | { enabled: false }
  | { enabled: true; picked: number; checked: number; failed: number; skipped: number; errors: number }

type Due = Pick<A2pRegistrationRow, "shop_id" | "status" | "check_failures">

/**
 * One reconciler run. `supabase` must be a service-role client. `origin` is
 * Gradia's public origin (for a messaging service's inbound URL).
 */
export async function reconcileA2pRegistrations(input: {
  supabase: SupabaseClient
  origin: string
  env?: Env
  batch?: number
  now?: () => Date
}): Promise<A2pReconcileSummary> {
  const env = input.env ?? process.env
  if (!a2pReconcilerEnabled(env)) return { enabled: false }
  const { supabase, origin } = input
  const now = input.now ?? (() => new Date())
  const schedule = a2pReconcileSchedule(env)

  const { data: due, error } = await supabase
    .from("a2p_registrations")
    .select("shop_id, status, check_failures")
    .in("status", A2P_RECONCILE_STATUSES as unknown as string[])
    .or(`next_check_at.is.null,next_check_at.lte.${now().toISOString()}`)
    .order("next_check_at", { ascending: true, nullsFirst: true })
    .limit(batchSize(input.batch, env))
  if (error) throw new Error(`Couldn't list registrations to check: ${error.message}`)

  const summary = { enabled: true as const, picked: due?.length ?? 0, checked: 0, failed: 0, skipped: 0, errors: 0 }
  for (const row of (due ?? []) as Due[]) {
    try {
      const outcome = await refreshOne(supabase, origin, row, schedule, env, now)
      summary[outcome] += 1
    } catch (err) {
      // One shop's problem never stops the others.
      summary.errors += 1
      console.error(`[a2p-reconciler] shop ${row.shop_id}:`, err instanceof Error ? err.message : err)
    }
  }
  return summary
}

async function refreshOne(
  supabase: SupabaseClient,
  origin: string,
  before: Due,
  schedule: ReturnType<typeof a2pReconcileSchedule>,
  env: Env,
  now_: () => Date
): Promise<"checked" | "failed" | "skipped"> {
  const { data: shop, error } = await supabase.from("shops").select("*").eq("id", before.shop_id).single()
  if (error || !shop) throw new Error("shop unreadable")
  const result = await syncA2pStatus({ supabase, shop: shop as ShopRow, origin })

  if (!result.check) {
    // This call read nothing. Usually another check held the claim: its
    // holder schedules, so leave the row alone. But a registration with
    // nothing to read yet (no brand SID, or no campaign) would stay due
    // forever and starve the batch: push that one back.
    const { data: row } = await supabase
      .from("a2p_registrations")
      .select("status, brand_sid, messaging_service_sid, campaign_sid")
      .eq("shop_id", before.shop_id)
      .single()
    const nothingToRead = row && (row.status === "brand_pending" ? !row.brand_sid : !row.messaging_service_sid || !row.campaign_sid)
    if (nothingToRead) {
      await supabase
        .from("a2p_registrations")
        .update({ next_check_at: new Date(now_().getTime() + schedule.settledIntervalMs).toISOString() })
        .eq("shop_id", before.shop_id)
    }
    return "skipped"
  }
  const checked = result.check === "answered"
  const failures = checked ? 0 : (before.check_failures ?? 0) + 1
  const settled = result.status === "approved" || result.status === "suspended"
  const waitMs = failures > 0 ? a2pBackoffMs(failures, env) : settled ? schedule.settledIntervalMs : schedule.pendingIntervalMs
  await supabase
    .from("a2p_registrations")
    .update({ check_failures: failures, next_check_at: new Date(now_().getTime() + waitMs).toISOString() })
    .eq("shop_id", before.shop_id)
  return checked ? "checked" : "failed"
}
