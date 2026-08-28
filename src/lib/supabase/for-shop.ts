/**
 * forShop — tenant-scoped facade over a Supabase client (P0-011 helper
 * design; ADR-003).
 *
 * The service-role client bypasses RLS, so on tenant-owned tables every
 * query must carry `.eq("shop_id", …)` and every insert must stamp
 * `shop_id` — today that is per-line DISCIPLINE across ~30 files. This
 * facade turns it into MECHANISM: the scope is applied by construction,
 * the `shopId` must be handed over explicitly at creation (from a trusted
 * server-side resolution — session shop, verified provider mapping,
 * cron-loaded row), and anything deliberately global goes through the
 * loudly-named `unscoped` escape hatch instead of quietly omitting a
 * predicate.
 *
 * Deliberately NOT an ORM or repository layer: each method returns the
 * live PostgREST builder mid-chain, so call sites read exactly like the
 * raw client minus the scoping boilerplate:
 *
 *   const db = forShop(supabase, shop.id)
 *   await db.update("import_jobs", { status: "failed" }).eq("id", id)
 *   await db.upsert("shop_metrics", row, { onConflict: "…" })
 *   await db.unscoped.from("pricing_config").select("*")   // global table
 *
 * P0-011 converts two cron call sites as the design proof; the full
 * migration is the follow-up ticket set enumerated in ADR-003.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Row = Record<string, unknown>

function stamp(shopId: string, rows: Row | Row[]): Row | Row[] {
  return Array.isArray(rows)
    ? rows.map((r) => ({ ...r, shop_id: shopId }))
    : { ...rows, shop_id: shopId }
}

export function forShop(client: SupabaseClient, shopId: string) {
  if (!shopId) {
    // Fail closed at construction — a scoped client with no tenant is a bug
    // at the call site, never something to paper over with a global query.
    throw new Error("forShop requires a non-empty trusted shopId")
  }
  return {
    /** The tenant every operation is bound to. */
    shopId,
    /** SELECT already filtered by shop_id; chain further filters freely. */
    select: (table: string, columns = "*") =>
      client.from(table).select(columns).eq("shop_id", shopId),
    /** UPDATE already filtered by shop_id; chain `.eq("id", …)` etc. */
    update: (table: string, values: Row) =>
      client.from(table).update(values).eq("shop_id", shopId),
    /** DELETE already filtered by shop_id; chain further filters. */
    delete: (table: string) =>
      client.from(table).delete().eq("shop_id", shopId),
    /** INSERT with shop_id stamped onto every row — the authorized tenant
     *  always wins over anything the payload carried. */
    insert: (table: string, rows: Row | Row[]) =>
      client.from(table).insert(stamp(shopId, rows)),
    /** UPSERT with shop_id stamped onto every row. */
    upsert: (
      table: string,
      rows: Row | Row[],
      options?: { onConflict?: string; ignoreDuplicates?: boolean }
    ) => client.from(table).upsert(stamp(shopId, rows), options),
    /** The raw client — the EXPLICIT escape hatch for tenant-independent
     *  tables (pricing_config, rate_limits) or deliberate cross-tenant
     *  sweeps. Its presence in a diff is the review signal. */
    unscoped: client,
  }
}

export type ShopScopedClient = ReturnType<typeof forShop>
