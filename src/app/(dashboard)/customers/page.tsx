import Link from "next/link"
import { FileText, Users } from "lucide-react"

import { getCrmHealthForCurrentShop } from "@/app/actions/crm-cleanup"
import { listQuotesForCurrentShop } from "@/app/actions/quotes"
import { CrmCleanupCard } from "@/components/gradia/crm-cleanup-card"
import { CustomersTable } from "@/components/gradia/customers-table"
import { PipelineBoard } from "@/components/gradia/pipeline-board"
import { QuotesList } from "@/components/gradia/quotes-list"
import { buttonVariants } from "@/components/ui/button"
import { listCustomersForCurrentShop } from "@/lib/data/customers"
import { listPipelineForCurrentShop } from "@/lib/data/pipeline"
import { FEATURES } from "@/lib/features"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

type HubTab = "pipeline" | "customers" | "quotes"

const TABS: { key: HubTab; label: string }[] = [
  { key: "pipeline", label: "Pipeline" },
  { key: "customers", label: "Customers" },
  { key: "quotes", label: "Quotes" },
]

/**
 * Customers hub (CRM C2 + resolved 5-page IA): Pipeline (default) ·
 * Customers · Quotes — one page, one mental model: the people and the money.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>
}) {
  const params = await searchParams
  const tab: HubTab = TABS.some((t) => t.key === params.tab)
    ? (params.tab as HubTab)
    : "pipeline"
  const query = params.q?.trim() ?? ""

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="label-eyebrow text-muted-foreground/70">Customers</p>
          <h1 className="font-display text-2xl text-foreground">
            The people and the <span className="italic">money</span>.
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Every lead as a card, every person as a file, every quote in one
            list — from first call to booked job without leaving this page.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {tab === "quotes" ? (
            <Link
              href="/customers/quotes/new"
              className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2")}
            >
              <FileText className="size-4" aria-hidden />
              New quote
            </Link>
          ) : null}
          {tab === "customers" && FEATURES.customerRecovery ? (
            <Link
              href="/customers/recovery"
              className={cn(buttonVariants({ size: "lg" }), "h-11 gap-2")}
            >
              <Users className="size-4" aria-hidden />
              Import customers
            </Link>
          ) : null}
        </div>
      </header>

      <nav className="flex gap-1 border-b border-border/60" aria-label="Customer views">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "pipeline" ? "/customers" : `/customers?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3.5 py-2 text-sm transition-colors",
              tab === t.key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "pipeline" ? <PipelineTab /> : null}
      {tab === "customers" ? <CustomersTab query={query} /> : null}
      {tab === "quotes" ? <QuotesTab /> : null}
    </div>
  )
}

async function PipelineTab() {
  const pipeline = await listPipelineForCurrentShop()
  return <PipelineBoard initial={pipeline} />
}

async function CustomersTab({ query }: { query: string }) {
  const customers = await listCustomersForCurrentShop(query || null)
  // Cleanup overview only on the unfiltered view (the "tidy up" first-win).
  const health = query ? null : await getCrmHealthForCurrentShop()
  return (
    <div className="space-y-8">
      {health && <CrmCleanupCard health={health} />}
      <CustomersTable initialQuery={query} customers={customers} />
    </div>
  )
}

async function QuotesTab() {
  const quotes = await listQuotesForCurrentShop()
  return <QuotesList quotes={quotes} />
}
