"use client"

import dynamic from "next/dynamic"
import Link from "next/link"

import type { HomeKpis, KpiSeries } from "@/lib/data/kpis"
import { STRINGS } from "@/lib/strings"
import { cn } from "@/lib/utils"

/**
 * Home KPI row (spec §8-A5): four headline numbers in Geist Mono.
 * Sparklines live in kpi-spark.tsx and load via next/dynamic so recharts
 * stays out of the dashboard's initial bundle — and they render ONLY when
 * the 7-day series has genuine variation. A flat or near-empty week gets
 * the plain number, never a fabricated trendline.
 */

/** Same-height placeholder keeps the card from shifting when the chart
 *  chunk arrives. */
const Spark = dynamic(() => import("@/components/gradia/kpi-spark"), {
  ssr: false,
  loading: () => <div className="h-8 w-full" aria-hidden />,
})

/** ≥2 nonzero days = a real shape worth drawing. */
function hasSignal(series: KpiSeries): boolean {
  return series.filter((v) => v > 0).length >= 2
}

function KpiCard({
  label,
  value,
  series,
  href,
  warn = false,
}: {
  label: string
  value: number
  series?: KpiSeries
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
      {series && hasSignal(series) ? <Spark series={series} /> : null}
    </>
  )
  const cardClass =
    "flex flex-col gap-1.5 rounded-md border border-border/60 bg-card px-4 py-3.5 transition-colors duration-150"
  if (href) {
    return (
      <Link href={href} className={cn(cardClass, "hover:border-border-strong")}>
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
      <p className="label-eyebrow text-muted-foreground/70">{s.kpisEyebrow}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={s.kpiCalls}
          value={kpis.callsToday}
          series={kpis.callsSeries}
        />
        <KpiCard
          label={s.kpiLeads}
          value={kpis.leadsToday}
          series={kpis.leadsSeries}
        />
        <KpiCard
          label={s.kpiBooked}
          value={kpis.bookedToday}
          series={kpis.bookedSeries}
        />
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
