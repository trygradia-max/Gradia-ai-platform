import type { SupabaseClient } from "@supabase/supabase-js"

/** Read fake evaluates filters rather than returning a canned row regardless
 * of tenant. Unknown operations fail so mutation tests cannot silently pass. */
export function readDb(tables: Record<string, Record<string, unknown>[]>, failTable?: string) {
  const reads: { table: string; filters: [string, unknown][] }[] = []
  const db = { from(table: string) {
    const filters: [string, unknown][] = []
    reads.push({ table, filters })
    const query = {
      select() { return query },
      eq(key: string, value: unknown) { filters.push([key, value]); return query },
      single() { return query.maybeSingle() },
      async maybeSingle() {
        const rows = (tables[table] ?? []).filter(row => filters.every(([k,v]) => row[k] === v))
        if (table === failTable || rows.length > 1) return { data: null, error: { message: "lookup failed" } }
        return { data: rows[0] ?? null, error: null }
      },
    }
    return query
  } }
  return { db: db as unknown as SupabaseClient, reads }
}
export const safeCustomer = {
  id: "c1", shop_id: "shop-1", phone: "+15551112222", email: "sam@example.test",
  do_not_contact: false, sms_opted_out_at: null,
}
export const safeShop = { id: "shop-1", timezone: "America/New_York", quiet_hours_start: 21, quiet_hours_end: 8 }
