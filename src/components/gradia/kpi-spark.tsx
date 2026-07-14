"use client"

import { Area, AreaChart, ResponsiveContainer } from "recharts"

import type { KpiSeries } from "@/lib/data/kpis"

/**
 * The KPI sparkline, isolated so recharts can be code-split out of the
 * dashboard's initial bundle (2026-07-13 master audit P1 — recharts was
 * statically imported on the hot path). Loaded via next/dynamic in
 * kpi-row.tsx; keep this file free of other exports.
 *
 * Tremor copy-paste SparkAreaChart pattern, retokened to the design
 * system.
 */
export default function Spark({ series }: { series: KpiSeries }) {
  const data = series.map((value, i) => ({ i, value }))
  return (
    <div className="h-8 w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id="kpi-spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--accent-text)"
            strokeWidth={1.5}
            fill="url(#kpi-spark-fill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
