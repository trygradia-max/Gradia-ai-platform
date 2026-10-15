import type { SupabaseClient } from "@supabase/supabase-js";
export type MergeChildTable = "leads" | "interactions" | "appointments" | "vehicles" | "quotes" | "payments" | "call_records" | "automation_runs";
export type RepointResult = {
    ok: true;
    moved: Record<MergeChildTable, number>;
} | {
    ok: false;
    table: string;
    error: string;
};
/** The RPC owns the entire merge, including consent, identifiers and deletion.
 * Never follow this call with a second application-side merge mutation. */
export async function repointCustomerChildren(db: SupabaseClient, shopId: string, winnerId: string, loserId: string): Promise<RepointResult> {
    const { data, error } = await db.rpc("merge_customers_atomic", { p_shop: shopId, p_winner: winnerId, p_loser: loserId });
    return error ? { ok: false, table: "atomic merge", error: error.message } : { ok: true, moved: data as Record<MergeChildTable, number> };
}
