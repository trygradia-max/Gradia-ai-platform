import { TrendingUp } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getRevenueSummaryForCurrentShop } from "@/lib/data/revenue"

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

function formatMoney(cents: number): string {
  return USD.format(cents / 100)
}

function invoiceLabel(count: number): string {
  if (count === 0) return "No paid invoices yet"
  if (count === 1) return "1 paid invoice"
  return `${count} paid invoices`
}

export async function RevenueTiles() {
  const summary = await getRevenueSummaryForCurrentShop()
  const hasAnyRevenue = summary.all_time.count > 0

  const tiles = [
    {
      key: "week",
      label: "This week",
      cents: summary.week.cents,
      count: summary.week.count,
    },
    {
      key: "month",
      label: "This month",
      cents: summary.month.cents,
      count: summary.month.count,
    },
    {
      key: "all_time",
      label: "All time",
      cents: summary.all_time.cents,
      count: summary.all_time.count,
    },
  ]

  return (
    <Card className="border-border/80">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60">
          <TrendingUp className="size-5 text-primary" aria-hidden />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base font-medium">What we&apos;ve earned</CardTitle>
          <p className="text-sm text-muted-foreground">
            {hasAnyRevenue
              ? "Paid Stripe invoices, summed up. Doesn't count what's still pending."
              : "Once a customer pays one of our invoices, the totals show up here."}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-3 sm:gap-6">
          {tiles.map((t) => (
            <div key={t.key} className="space-y-1">
              <dt className="text-xs uppercase tracking-widest text-muted-foreground">
                {t.label}
              </dt>
              <dd className="text-2xl font-semibold tracking-tight tabular-nums">
                {formatMoney(t.cents)}
              </dd>
              <dd className="text-xs text-muted-foreground">
                {invoiceLabel(t.count)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}
