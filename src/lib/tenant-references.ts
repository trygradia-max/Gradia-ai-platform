import type { SupabaseClient } from "@supabase/supabase-js"

const parents = { customer_id: "customers", lead_id: "leads", vehicle_id: "vehicles", appointment_id: "appointments", quote_id: "quotes" } as const
export type TenantReferences = Partial<Record<keyof typeof parents, unknown>>
type Parent = { id: string; shop_id: string; customer_id?: string | null }

/** Also check returned identity: service-role clients bypass RLS, and tests must
 * not conceal missing predicates with filter-ignoring fake results. */
export async function ownedReference(db: SupabaseClient, shopId: string, table: typeof parents[keyof typeof parents], id: unknown): Promise<Parent | null> {
  if (typeof id !== "string" || !id.trim()) return null
  try {
    const { data, error } = await db.from(table)
      .select(table === "customers" ? "id, shop_id" : "id, shop_id, customer_id")
      .eq("shop_id", shopId).eq("id", id).maybeSingle()
    const row = data as Parent | null
    return !error && row?.id === id && row.shop_id === shopId ? row : null
  } catch { return null }
}

export async function validTenantReferences(db: SupabaseClient, shopId: string, refs: TenantReferences): Promise<boolean> {
  for (const key of Object.keys(parents) as (keyof typeof parents)[]) {
    const id = refs[key]
    if (id !== null && id !== undefined && !await ownedReference(db, shopId, parents[key], id)) return false
  }
  return true
}

export async function validQuoteReferences(db: SupabaseClient, shopId: string, refs: { customer_id: string; vehicle_id?: string | null; lead_id?: string | null }): Promise<boolean> {
  if (!await ownedReference(db, shopId, "customers", refs.customer_id)) return false
  if (refs.vehicle_id != null) {
    const vehicle = await ownedReference(db, shopId, "vehicles", refs.vehicle_id)
    if (!vehicle || vehicle.customer_id !== refs.customer_id) return false
  }
  if (refs.lead_id != null) {
    const lead = await ownedReference(db, shopId, "leads", refs.lead_id)
    if (!lead || (lead.customer_id != null && lead.customer_id !== refs.customer_id)) return false
  }
  return true
}
