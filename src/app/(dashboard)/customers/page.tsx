import { getCrmHealthForCurrentShop } from "@/app/actions/crm-cleanup"
import { CrmCleanupCard } from "@/components/gradia/crm-cleanup-card"
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
  // Cleanup overview only on the unfiltered view (the "tidy up" first-win).
  const health = query ? null : await getCrmHealthForCurrentShop()

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <header className="space-y-2">
        <p className="label-eyebrow text-muted-foreground/70">Customers</p>
        <h1 className="font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] tracking-[-0.025em] text-foreground">
          <span className="italic">Everyone</span> we&apos;ve heard from.
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Voice, SMS, email, socials, the front desk — all stitched into one
          file per person. Click in to see the whole thread.
        </p>
      </header>

      {health && <CrmCleanupCard health={health} />}

      <CustomersTable initialQuery={query} customers={customers} />
    </div>
  )
}
