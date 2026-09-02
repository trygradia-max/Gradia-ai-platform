/**
 * Usage anomaly detection — the platform-cost early-warning system.
 *
 * Reads the usage_events ledger (every priced row carries retail_cost +
 * wholesale_cost) and flags three things the over-usage protections can't
 * prevent on their own:
 *   - spend_spike   — a shop's spend today far above its trailing average
 *                     (abuse, a stuck loop, or a runaway autonomous agent)
 *   - margin_floor  — a shop running below the gross-margin floor (a pricing
 *                     bug or a cost regression eating the markup)
 *   - global_ceiling — platform-wide daily spend crossing a configured ceiling
 *                     (the code-side backstop to the vendor caps in the runbook)
 *
 * Detection + structured alerts: every anomaly is logged (`[monitoring]`)
 * AND delivered through the ops alert seam (P0-012, `lib/alerts.ts`) —
 * global_ceiling as SEV-1, spend_spike / margin_floor as SEV-2. Read-only;
 * never mutates.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { sendOpsAlert } from "@/lib/alerts"

export type UsageAnomaly = {
  kind: "spend_spike" | "margin_floor" | "global_ceiling"
  shopId: string | null
  detail: string
}

/**
 * Structured tenant-scope violation signal (P0-011). A claim or mutation was
 * refused because the caller's authorized shop did not match the row's shop —
 * an attack or a bug, never noise. Emitted with the same `[monitoring]`
 * prefix the anomaly sweep uses, AND delivered as a SEV-0 through the ops
 * alert seam (P0-012 — cross-tenant shapes start one level up per the
 * severity runbook). Fire-and-forget: the seam never throws, and the
 * refusal must not wait on delivery. Never throws.
 */
export function reportTenantScopeViolation(input: {
  surface: string
  authorizedShopId: string
  rowShopId: string | null
  rowId: string
  detail?: string
}): void {
  console.error(
    `[monitoring] TENANT_SCOPE_VIOLATION surface=${input.surface} row=${input.rowId} authorized_shop=${input.authorizedShopId} row_shop=${input.rowShopId ?? "unknown"}${input.detail ? ` — ${input.detail}` : ""}`
  )
  void sendOpsAlert({
    severity: "SEV-0",
    source: "tenancy",
    title: `TENANT_SCOPE_VIOLATION ${input.surface}`,
    detail: input.detail,
    refs: {
      row: input.rowId,
      authorized_shop: input.authorizedShopId,
      row_shop: input.rowShopId ?? "unknown",
      action: "refused — no write performed",
      retryable: false,
    },
  })
}

const SPIKE_FACTOR = 3 // today ≥ 3× the trailing daily average
const SPIKE_MIN_CENTS = 500 // ignore noise below $5/day
const MARGIN_FLOOR = 0.5 // alert under 50% gross margin
const LOOKBACK_DAYS = 8

type UsageRow = {
  shop_id: string
  created_at: string
  retail_cost: number | null
  wholesale_cost: number | null
}

type ShopAgg = {
  todayRetail: number
  priorByDay: Map<string, number>
  retail: number
  wholesale: number
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

export async function detectUsageAnomalies(
  supabase: SupabaseClient
): Promise<UsageAnomaly[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabase
    .from("usage_events")
    .select("shop_id, created_at, retail_cost, wholesale_cost")
    .gte("created_at", since)
  if (error) {
    console.error("[monitoring] usage read failed:", error)
    return []
  }
  const rows = (data as UsageRow[] | null) ?? []
  const today = new Date().toISOString().slice(0, 10)

  const byShop = new Map<string, ShopAgg>()
  let globalTodayRetail = 0

  for (const r of rows) {
    const day = r.created_at.slice(0, 10)
    const retail = r.retail_cost ?? 0
    const wholesale = r.wholesale_cost ?? 0
    const agg =
      byShop.get(r.shop_id) ??
      ({ todayRetail: 0, priorByDay: new Map(), retail: 0, wholesale: 0 } as ShopAgg)
    agg.retail += retail
    agg.wholesale += wholesale
    if (day === today) {
      agg.todayRetail += retail
      globalTodayRetail += retail
    } else {
      agg.priorByDay.set(day, (agg.priorByDay.get(day) ?? 0) + retail)
    }
    byShop.set(r.shop_id, agg)
  }

  const anomalies: UsageAnomaly[] = []

  for (const [shopId, a] of byShop) {
    const priorDays = a.priorByDay.size
    const priorTotal = [...a.priorByDay.values()].reduce((s, v) => s + v, 0)
    const avg = priorDays > 0 ? priorTotal / priorDays : 0
    if (a.todayRetail >= SPIKE_MIN_CENTS && avg > 0 && a.todayRetail >= SPIKE_FACTOR * avg) {
      anomalies.push({
        kind: "spend_spike",
        shopId,
        detail: `today ${dollars(a.todayRetail)} vs ${SPIKE_FACTOR}× trailing avg ${dollars(avg)}`,
      })
    }
    if (a.retail >= SPIKE_MIN_CENTS) {
      const margin = (a.retail - a.wholesale) / a.retail
      if (margin < MARGIN_FLOOR) {
        anomalies.push({
          kind: "margin_floor",
          shopId,
          detail: `gross margin ${(margin * 100).toFixed(0)}% over ${LOOKBACK_DAYS}d (retail ${dollars(a.retail)}, cost ${dollars(a.wholesale)})`,
        })
      }
    }
  }

  // Code-side backstop to the vendor caps (over-usage runbook #5). Off unless
  // GLOBAL_DAILY_COST_CEILING_CENTS is set in the environment.
  const ceiling = Number(process.env.GLOBAL_DAILY_COST_CEILING_CENTS ?? 0)
  if (ceiling > 0 && globalTodayRetail >= ceiling) {
    anomalies.push({
      kind: "global_ceiling",
      shopId: null,
      detail: `platform retail spend today ${dollars(globalTodayRetail)} ≥ ceiling ${dollars(ceiling)}`,
    })
  }

  for (const a of anomalies) {
    console.error(
      `[monitoring] ANOMALY ${a.kind} shop=${a.shopId ?? "ALL"} — ${a.detail}`
    )
  }
  // Delivery (P0-012): one alert per anomaly; the seam never throws.
  await Promise.all(
    anomalies.map((a) =>
      sendOpsAlert({
        severity: a.kind === "global_ceiling" ? "SEV-1" : "SEV-2",
        source: "monitoring",
        title: `Usage anomaly: ${a.kind} shop=${a.shopId ?? "ALL"}`,
        detail: a.detail,
        refs: {
          kind: a.kind,
          shop_id: a.shopId ?? "ALL",
          action: "detected — no automatic mitigation",
          retryable: false,
        },
      })
    )
  )
  return anomalies
}
