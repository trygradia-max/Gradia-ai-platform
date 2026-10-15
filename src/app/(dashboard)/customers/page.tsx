import Link from "next/link"
import { redirect } from "next/navigation"
import { FileText, Users } from "lucide-react"

import { getCrmHealthForCurrentShop } from "@/app/actions/crm-cleanup"
import { CrmCleanupCard } from "@/components/gradia/crm-cleanup-card"
import { CustomersTable } from "@/components/gradia/customers-table"
import { SectionHeader } from "@/components/gradia/section-header"
import { buttonVariants } from "@/components/ui/button"
import { listCustomersForCurrentShop } from "@/lib/data/customers"
import { FEATURES } from "@/lib/features"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

/**
 * Customers is the contact file (U-02). Pipeline and quotes are their
 * own routes; old tab URLs redirect so bookmarks still land somewhere true.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>
}) {
  const params = await searchParams
  if (params.tab === "pipeline") redirect("/pipeline")
  if (params.tab === "quotes") redirect("/customers/quotes")
  if (params.tab) {
    const q = params.q?.trim()
    redirect(q ? `/customers?q=${encodeURIComponent(q)}` : "/customers")
  }

  const query = params.q?.trim() ?? ""
  const customers = await listCustomersForCurrentShop(query || null)
  const health = query ? null : await getCrmHealthForCurrentShop()
  const s = STRINGS.pages.customers

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <SectionHeader
          level={1}
          eyebrow={s.eyebrow}
          title={s.title}
          subhead={s.subtitle}
        />
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link
            href="/customers/quotes"
            className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 gap-2")}
          >
            <FileText className="size-4" aria-hidden />
            {s.quotes}
          </Link>
          {FEATURES.customerRecovery ? (
            <Link
              href="/customers/recovery"
              className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 gap-2")}
            >
              <Users className="size-4" aria-hidden />
              Import customers
            </Link>
          ) : null}
        </div>
      </div>

      {health ? <CrmCleanupCard health={health} /> : null}
      <CustomersTable initialQuery={query} customers={customers} />
    </div>
  )
}
