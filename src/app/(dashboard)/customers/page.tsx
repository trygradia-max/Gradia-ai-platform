import { CustomersTable } from "@/components/gradia/customers-table"
import { listCustomersForCurrentShop } from "@/lib/data/customers"

export const dynamic = "force-dynamic"

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const params = await searchParams
  const query = params.q?.trim() ?? ""
  const customers = await listCustomersForCurrentShop(query || null)

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Our customers</h1>
          <p className="text-sm text-muted-foreground">
            Everyone we&apos;ve heard from — across voice, SMS, email, and
            socials. Click in to see the whole thread.
          </p>
        </div>
      </div>
      <CustomersTable initialQuery={query} customers={customers} />
    </div>
  )
}
