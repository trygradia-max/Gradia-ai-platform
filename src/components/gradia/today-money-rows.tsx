import Link from "next/link"

import { formatPriceUsd } from "@/lib/service-pricing"
import type { TodayMoneyData } from "@/lib/data/today-money"

/**
 * C8 — the money row and the leak row, below the existing receipt/feed
 * order. Every tile renders only when nonzero (existing rule), every
 * number is SQL-derived, every card links somewhere actionable. Mobile
 * collapses to a single column.
 */
export function TodayMoneyRows({ data }: { data: TodayMoneyData }) {
  const { money, leaks, attribution } = data

  const moneyTiles = [
    {
      label: "Booked this week",
      cents: money.bookedThisWeekCents,
      href: "/calendar",
    },
    {
      label: "Completed this week",
      cents: money.completedThisWeekCents,
      href: "/calendar",
    },
    {
      label: "Pipeline value",
      cents: money.pipelineValueCents,
      href: "/customers",
    },
    {
      label: `Quotes out (${money.quotesOutstandingCount})`,
      cents: money.quotesOutstandingCents,
      href: "/customers?tab=quotes",
    },
  ].filter((t) => t.cents > 0)

  const leakTiles = [
    leaks.newLeadsThisWeek > 0
      ? {
          label: "New leads",
          value: `${leaks.newLeadsToday} today · ${leaks.newLeadsThisWeek} this week`,
          href: "/customers",
        }
      : null,
    leaks.lostThisWeek > 0
      ? {
          label: "Lost this week",
          value: `${leaks.lostThisWeek}${leaks.topLostReason ? ` · mostly ${leaks.topLostReason.replace(/_/g, " ")}` : ""}`,
          href: "/customers",
        }
      : null,
    leaks.reviewRequestsPending > 0
      ? {
          label: "Review asks waiting",
          value: `${leaks.reviewRequestsPending} in Approvals`,
          href: "/approvals",
        }
      : null,
  ].filter((t): t is NonNullable<typeof t> => t !== null)

  if (moneyTiles.length === 0 && leakTiles.length === 0 && attribution.bookedCount === 0) {
    return null
  }

  return (
    <section className="space-y-4">
      {moneyTiles.length > 0 ? (
        <div>
          <p className="label-eyebrow pb-2 text-muted-foreground/70">The money</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {moneyTiles.map((t) => (
              <Link
                key={t.label}
                href={t.href}
                className="rounded-md border border-border/60 bg-card px-4 py-3 transition-colors hover:border-border"
              >
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="font-data mt-1 text-xl font-semibold text-foreground">
                  {formatPriceUsd(t.cents)}
                </p>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {leakTiles.length > 0 ? (
        <div>
          <p className="label-eyebrow pb-2 text-muted-foreground/70">The leaks</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {leakTiles.map((t) => (
              <Link
                key={t.label}
                href={t.href}
                className="rounded-md border border-border/60 bg-card px-4 py-3 transition-colors hover:border-border"
              >
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="font-data mt-1 text-sm font-medium text-foreground">
                  {t.value}
                </p>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {attribution.bookedCount > 0 ? (
        // The retention line — computed from automation_runs → booking joins,
        // never estimated. Under-claims by design (quote-backed only).
        <p className="text-sm text-muted-foreground">
          Follow-ups booked{" "}
          <span className="font-data font-medium text-foreground">
            {formatPriceUsd(attribution.bookedCents)}
          </span>{" "}
          this month ({attribution.bookedCount} booking
          {attribution.bookedCount === 1 ? "" : "s"} from automations).
        </p>
      ) : null}
    </section>
  )
}
