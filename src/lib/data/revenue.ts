import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"

const DAY_MS = 24 * 60 * 60 * 1000

export type RevenueBucket = {
  cents: number
  count: number
}

export type RevenueSummary = {
  week: RevenueBucket
  month: RevenueBucket
  all_time: RevenueBucket
}

const EMPTY_SUMMARY: RevenueSummary = {
  week: { cents: 0, count: 0 },
  month: { cents: 0, count: 0 },
  all_time: { cents: 0, count: 0 },
}

/**
 * Sums paid-invoice revenue for the current shop, bucketed into
 * this week (7d) / this month (30d) / all time. One SELECT against
 * the local payments table; bucketing happens in JS so we don't pay
 * for three round-trips. The (shop_id, paid_at DESC) index keeps it
 * fast even with thousands of rows.
 *
 * Refunds aren't tracked yet (Stripe charge.refunded webhook isn't
 * wired), so "revenue" here means "paid invoices."
 */
export async function getRevenueSummaryForCurrentShop(): Promise<RevenueSummary> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("payments")
    .select("amount_cents, paid_at")
    .eq("shop_id", shop.id)

  if (error) {
    console.error("[revenue summary] query failed:", error)
    return EMPTY_SUMMARY
  }

  const rows = (data as { amount_cents: number; paid_at: string }[] | null) ?? []
  if (rows.length === 0) return EMPTY_SUMMARY

  const now = Date.now()
  const weekCutoff = now - 7 * DAY_MS
  const monthCutoff = now - 30 * DAY_MS

  const summary: RevenueSummary = {
    week: { cents: 0, count: 0 },
    month: { cents: 0, count: 0 },
    all_time: { cents: 0, count: 0 },
  }

  for (const row of rows) {
    const cents = row.amount_cents ?? 0
    if (cents <= 0) continue
    const paidMs = new Date(row.paid_at).getTime()
    summary.all_time.cents += cents
    summary.all_time.count += 1
    if (paidMs >= monthCutoff) {
      summary.month.cents += cents
      summary.month.count += 1
    }
    if (paidMs >= weekCutoff) {
      summary.week.cents += cents
      summary.week.count += 1
    }
  }

  return summary
}
