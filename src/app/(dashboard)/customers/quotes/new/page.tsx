import { QuoteBuilder } from "@/components/gradia/quote-builder"
import { SectionHeader } from "@/components/gradia/section-header"
import { getCustomerVehicles } from "@/app/actions/quotes"
import { listServicesForCurrentShop } from "@/lib/data/services"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

/**
 * Quote builder (CRM C3b) — reachable from Customers surfaces and pipeline
 * cards (?customer=…&lead=…). Target: sendable in 60 seconds.
 */
export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; lead?: string }>
}) {
  const params = await searchParams
  const shop = await requireShop()
  const supabase = await createClient()

  const [{ data: customerData }, services] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, phone, email")
      .eq("shop_id", shop.id)
      .order("name", { ascending: true })
      .limit(400),
    listServicesForCurrentShop(),
  ])
  const customers =
    (customerData as { id: string; name: string | null; phone: string | null; email: string | null }[] | null) ??
    []

  const preselectedId =
    params.customer && customers.some((c) => c.id === params.customer)
      ? params.customer
      : null
  const vehicles = preselectedId ? await getCustomerVehicles(preselectedId) : []

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <SectionHeader
        level={1}
        eyebrow="New quote"
        title="Price it once, send it anywhere."
        subhead="Prices come straight from your service menu for this vehicle's size — the same numbers the receptionist quotes on the phone."
      />

      <QuoteBuilder
        customers={customers}
        services={services}
        initialCustomerId={preselectedId}
        initialVehicles={vehicles}
        leadId={params.lead ?? null}
      />
    </div>
  )
}
