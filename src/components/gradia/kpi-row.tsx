import Link from "next/link"

import type { HomeKpis } from "@/lib/data/kpis"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

/**
 * Home metric cards. Counts are real shop numbers. Sparklines are omitted —
 * a flat week is not a chart, and decorative metrics are out of this pass.
 */

function KpiCard({
  label,
  value,
  href,
  warn = false,
}: {
  label: string
  value: number
  href?: string
  warn?: boolean
}) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "font-data text-2xl font-semibold",
          warn && value > 0 ? "text-status-warning-fg" : "text-foreground"
        )}
      >
        {value}
      </p>
    </>
  )
  const cardClass =
    "flex min-h-11 flex-col gap-1.5 rounded-md bg-card px-4 py-3.5 ring-1 ring-border"
  if (href) {
    return (
      <Link href={href} className={cn(cardClass, "outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50")}>
        {body}
      </Link>
    )
  }
  return <div className={cardClass}>{body}</div>
}

export function KpiRow({ kpis }: { kpis: HomeKpis }) {
  const s = STRINGS.pages.home
  return (
    <section className="space-y-3">
      <p className="label-eyebrow text-muted-foreground">{s.kpisEyebrow}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label={s.kpiCalls} value={kpis.callsToday} />
        <KpiCard label={s.kpiLeads} value={kpis.leadsToday} />
        <KpiCard label={s.kpiBooked} value={kpis.bookedToday} />
        <KpiCard
          label={s.kpiNeedsReview}
          value={kpis.needsReview}
          href="/approvals"
          warn
        />
      </div>
    </section>
  )
}
