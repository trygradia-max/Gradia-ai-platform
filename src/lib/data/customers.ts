import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"
import type {
  AppointmentRow,
  CustomerRow,
  InteractionRow,
  LeadRow,
} from "@/lib/types/database"

export type CustomerWithCounts = CustomerRow & {
  lead_count: number
  last_seen_at: string | null
}

const LIST_LIMIT = 200

/**
 * Lists customers for the current shop, optionally filtered by a
 * free-text query that matches name / phone / email / IG / FB.
 * Annotated with lead_count + last_seen_at for the index view's
 * "warmest customer first" sort. RLS scopes everything to the shop.
 */
export async function listCustomersForCurrentShop(
  query: string | null
): Promise<CustomerWithCounts[]> {
  const shop = await requireShop()
  const supabase = await createClient()

  let req = supabase.from("customers").select("*").eq("shop_id", shop.id)

  const q = query?.trim()
  if (q) {
    // Supabase `or` filter — ilike against each identifier column.
    // % escaping is handled by Supabase as long as we don't inject
    // commas/parens; trim defensively.
    const safe = q.replace(/[,()]/g, "").slice(0, 80)
    const pattern = `%${safe}%`
    req = req.or(
      [
        `name.ilike.${pattern}`,
        `phone.ilike.${pattern}`,
        `email.ilike.${pattern}`,
      ].join(",")
    )
  }

  const { data, error } = await req
    .order("updated_at", { ascending: false })
    .limit(LIST_LIMIT)

  if (error) throw new Error(error.message)
  const customers = (data as CustomerRow[] | null) ?? []
  if (customers.length === 0) return []

  const ids = customers.map((c) => c.id)
  const [leadCounts, latestInteractions] = await Promise.all([
    leadCountsByCustomer(supabase, shop.id, ids),
    lastInteractionByCustomer(supabase, shop.id, ids),
  ])

  return customers.map((c) => ({
    ...c,
    lead_count: leadCounts.get(c.id) ?? 0,
    last_seen_at: latestInteractions.get(c.id) ?? null,
  }))
}

type SupabaseAny = Awaited<ReturnType<typeof createClient>>

async function leadCountsByCustomer(
  supabase: SupabaseAny,
  shopId: string,
  customerIds: string[]
): Promise<Map<string, number>> {
  const { data } = await supabase
    .from("leads")
    .select("customer_id")
    .eq("shop_id", shopId)
    .in("customer_id", customerIds)
  const rows = (data as { customer_id: string | null }[] | null) ?? []
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.customer_id) continue
    counts.set(r.customer_id, (counts.get(r.customer_id) ?? 0) + 1)
  }
  return counts
}

async function lastInteractionByCustomer(
  supabase: SupabaseAny,
  shopId: string,
  customerIds: string[]
): Promise<Map<string, string>> {
  const { data } = await supabase
    .from("interactions")
    .select("customer_id, occurred_at")
    .eq("shop_id", shopId)
    .in("customer_id", customerIds)
    .order("occurred_at", { ascending: false })
  const rows =
    (data as { customer_id: string | null; occurred_at: string }[] | null) ?? []
  const out = new Map<string, string>()
  for (const r of rows) {
    if (!r.customer_id) continue
    if (!out.has(r.customer_id)) {
      out.set(r.customer_id, r.occurred_at)
    }
  }
  return out
}

export type CustomerDetail = {
  customer: CustomerRow
  interactions: InteractionRow[]
  leads: LeadRow[]
  appointments: AppointmentRow[]
}

const INTERACTIONS_LIMIT = 50

/**
 * Loads the customer detail page bundle. Returns null when the
 * customer doesn't exist or doesn't belong to the current shop —
 * the caller renders a 404.
 */
export async function getCustomerDetailForCurrentShop(
  customerId: string
): Promise<CustomerDetail | null> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: customerRow, error: customerErr } = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  if (customerErr) throw new Error(customerErr.message)
  if (!customerRow) return null
  const customer = customerRow as CustomerRow

  const [interactionsRes, leadsRes, appointmentsRes] = await Promise.all([
    supabase
      .from("interactions")
      .select("*")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .order("occurred_at", { ascending: false })
      .limit(INTERACTIONS_LIMIT),
    supabase
      .from("leads")
      .select("*")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    supabase
      .from("appointments")
      .select("*")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .order("scheduled_at", { ascending: false }),
  ])

  return {
    customer,
    interactions: (interactionsRes.data as InteractionRow[] | null) ?? [],
    leads: (leadsRes.data as LeadRow[] | null) ?? [],
    appointments:
      (appointmentsRes.data as AppointmentRow[] | null) ?? [],
  }
}
