import Link from "next/link"
import { Users } from "lucide-react"

import { getCrmHealthForCurrentShop } from "@/app/actions/crm-cleanup"
import { CrmCleanupCard } from "@/components/gradia/crm-cleanup-card"
import { CustomersTable } from "@/components/gradia/customers-table"
import { buttonVariants } from "@/components/ui/button"
import { listCustomersForCurrentShop } from "@/lib/data/customers"
import { FEATURES } from "@/lib/features"
import { cn } from "@/lib/utils"

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
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">Customers</p>
          <h1 className="font-display text-2xl text-foreground">
            <span className="italic">Everyone</span>{" "}we&apos;ve heard from.
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Voice, SMS, email, socials, the front desk — all stitched into one
            file per person. Click in to see the whole thread.
          </p>
        </div>
        {FEATURES.customerRecovery && (
          <Link
            href="/recovery"
            className={cn(buttonVariants({ size: "lg" }), "h-11 shrink-0 gap-2")}
          >
            <Users className="size-4" aria-hidden />
            Import customers
          </Link>
        )}
      </header>

      {health && <CrmCleanupCard health={health} />}

      <CustomersTable initialQuery={query} customers={customers} />
    </div>
  )
}
