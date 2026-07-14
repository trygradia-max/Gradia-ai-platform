/**
 * Shared customer-merge core — the single code path that re-points every
 * child row from a losing customer to the winning one BEFORE the loser is
 * deleted.
 *
 * Why this module exists (2026-07-13 master audit, P1 data loss): two
 * divergent merge implementations (`actions/customers.ts` and
 * `actions/crm-cleanup.ts`) each re-pointed a different subset of child
 * tables. Both missed `quotes` (ON DELETE CASCADE) — merging two customers
 * silently destroyed the loser's quote history; one also missed `vehicles`
 * (also CASCADE). This module re-points the full FK map so neither caller
 * can drift again.
 *
 * FK map onto customers(id) as of C1:
 *   CASCADE  (rows destroyed on delete): interactions, vehicles, quotes
 *   SET NULL (attribution lost on delete): leads, appointments, payments,
 *            call_records, automation_runs
 *
 * All eight are re-pointed. Tables introduced after the pilot schema
 * (vehicles, quotes, call_records, automation_runs) may not exist on a
 * pre-migration database — a missing-relation error (42P01) on those is
 * tolerated (nothing to lose); errors on core tables abort the merge.
 *
 * NOT re-pointed: pending_actions references customers only via JSONB
 * payload (no FK). Approval execution resolves by phone as well as id, so
 * a merged-away id degrades to a phone match; rewriting staged payloads
 * here would change approval semantics and is out of scope.
 *
 * Not transactional (Supabase JS exposes no pg transactions). Re-point
 * failures abort before the delete, so the failure mode is a half-merged
 * pair that a re-run completes — never a deleted customer with orphaned or
 * destroyed children.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** Tables whose absence (pre-migration DB) is tolerable during re-point. */
const OPTIONAL_TABLES = new Set([
  "vehicles",
  "quotes",
  "call_records",
  "automation_runs",
])

const CHILD_TABLES = [
  "leads",
  "interactions",
  "appointments",
  "vehicles",
  "quotes",
  "payments",
  "call_records",
  "automation_runs",
] as const

export type MergeChildTable = (typeof CHILD_TABLES)[number]

export type RepointResult =
  | { ok: true; moved: Record<MergeChildTable, number> }
  | { ok: false; table: MergeChildTable; error: string }

/** Postgres "relation does not exist". */
const MISSING_RELATION = "42P01"

/**
 * Re-points every child row from `loserId` to `winnerId`, shop-scoped.
 * Call this BEFORE deleting the loser. Returns per-table moved counts.
 */
export async function repointCustomerChildren(
  supabase: SupabaseClient,
  shopId: string,
  winnerId: string,
  loserId: string
): Promise<RepointResult> {
  const moved = Object.fromEntries(
    CHILD_TABLES.map((t) => [t, 0])
  ) as Record<MergeChildTable, number>

  for (const table of CHILD_TABLES) {
    const res = await supabase
      .from(table)
      .update({ customer_id: winnerId })
      .eq("shop_id", shopId)
      .eq("customer_id", loserId)
      .select("id")
    if (res.error) {
      if (res.error.code === MISSING_RELATION && OPTIONAL_TABLES.has(table)) {
        continue // pre-migration DB — table absent, nothing to move
      }
      return { ok: false, table, error: res.error.message }
    }
    moved[table] = res.data?.length ?? 0
  }

  return { ok: true, moved }
}
