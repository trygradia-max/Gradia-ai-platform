import { QuoteBuilder } from "@/components/gradia/quote-builder"
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
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">New quote</p>
        <h1 className="font-display text-2xl text-foreground">
          Price it <span className="italic">once</span>, send it anywhere.
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Prices come straight from your service menu for this vehicle&apos;s
          size — the same numbers the receptionist quotes on the phone.
        </p>
      </header>

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
