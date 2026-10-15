import type { SupabaseClient } from "@supabase/supabase-js"

/** Read fake evaluates filters rather than returning a canned row regardless
 * of tenant. Unknown operations fail so mutation tests cannot silently pass. */
export function readDb(tables: Record<string, Record<string, unknown>[]>, failTable?: string) {
  const reads: { table: string; filters: [string, unknown][] }[] = []
  const db = { from(table: string) {
    const filters: [string, unknown][] = []
    reads.push({ table, filters })
    let ordering: {key:string;ascending:boolean}|null=null
    let maximum:number|undefined
    const query = {
      select() { return query },
      eq(key: string, value: unknown) { filters.push([key, value]); return query },
      order(key:string,options:{ascending:boolean}) {ordering={key,ascending:options.ascending};return query},
      limit(count:number) {maximum=count;return query},
      async single() { const result=await query.maybeSingle();return result.data?result:{data:null,error:result.error??{message:"Expected one row"}} },
      async maybeSingle() {
        let rows = (tables[table] ?? []).filter(row => filters.every(([k,v]) => row[k] === v))
        if(ordering) {const {key,ascending}=ordering;rows=rows.toSorted((a,b)=>String(a[key]).localeCompare(String(b[key]))*(ascending?1:-1))}
        if(maximum!==undefined) rows=rows.slice(0,maximum)
        if (table === failTable || rows.length > 1) return { data: null, error: { message: "lookup failed" } }
        return { data: rows[0] ?? null, error: null }
      },
    }
    return query
  } }
  return { db: db as unknown as SupabaseClient, reads }
}
export const safeCustomer = {
  phone_canonical: "+15551112222", email_canonical:"sam@example.test",
  id: "c1", shop_id: "shop-1", phone: "+15551112222", email: "sam@example.test",
  do_not_contact: false, sms_opted_out_at: null,
}
export const safeShop = { id: "shop-1", timezone: "America/New_York", quiet_hours_start: 21, quiet_hours_end: 8 }
