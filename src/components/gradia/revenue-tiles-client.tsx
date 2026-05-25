"use client"

import * as React from "react"
import { ArrowUpRight, Receipt } from "lucide-react"

import { Counter } from "@/components/gradia/motion/counter"
import { MotionCard } from "@/components/gradia/motion/motion-card"
import {
  PageStagger,
  StaggerItem,
} from "@/components/gradia/motion/page-stagger"
import type { RevenueSummary } from "@/lib/data/revenue"

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})

function formatMoney(cents: number): string {
  return USD.format(cents / 100)
}

function dollarsFromCents(cents: number): number {
  return cents / 100
}

function invoiceLabel(count: number): string {
  if (count === 0) return "No invoices yet"
  if (count === 1) return "1 paid invoice"
  return `${count} paid invoices`
}

export function RevenueTilesClient({
  summary,
}: {
  summary: RevenueSummary
}) {
  const hasAny = summary.all_time.count > 0
  type Tile = {
    key: string
    eyebrow: string
    cents: number
    count: number
    feature?: boolean
  }
  const tiles: Tile[] = [
    {
      key: "week",
      eyebrow: "This week",
      cents: summary.week.cents,
      count: summary.week.count,
    },
    {
      key: "month",
      eyebrow: "This month",
      cents: summary.month.cents,
      count: summary.month.count,
    },
    {
      key: "all_time",
      eyebrow: "All time",
      cents: summary.all_time.cents,
      count: summary.all_time.count,
      feature: true,
    },
  ]

  return (
    <PageStagger className="grid gap-3 sm:grid-cols-3 sm:gap-4">
      {tiles.map((t) => (
        <StaggerItem key={t.key}>
          <MotionCard
            interactive
            glow={t.feature}
            className="relative overflow-hidden p-5 sm:p-6"
          >
            {/* Eyebrow row */}
            <div className="flex items-center justify-between">
              <span className="label-eyebrow">{t.eyebrow}</span>
              <span className="text-muted-foreground/80">
                <Receipt className="size-3.5" aria-hidden />
              </span>
            </div>

            {/* Stat */}
            <div className="mt-4 flex items-baseline gap-1.5">
              <span className="font-display text-4xl text-foreground sm:text-5xl">
                <Counter
                  to={dollarsFromCents(t.cents)}
                  duration={1.6}
                >
                  {(v) => formatMoney(Math.round(v) * 100)}
                </Counter>
              </span>
            </div>

            {/* Footnote */}
            <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              {hasAny ? (
                <>
                  <ArrowUpRight
                    className="size-3 text-primary"
                    aria-hidden
                  />
                  <span>{invoiceLabel(t.count)}</span>
                </>
              ) : (
                <span>
                  Once a customer pays, it lands here.
                </span>
              )}
            </div>

            {/* Feature accent line — only on the headline tile */}
            {t.feature ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
              />
            ) : null}
          </MotionCard>
        </StaggerItem>
      ))}
    </PageStagger>
  )
}
