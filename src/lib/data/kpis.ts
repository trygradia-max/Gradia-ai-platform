import { createClient } from "@/lib/supabase/server"
import { getOptionalShop } from "@/lib/shop"

import { countOpenApprovalsForCurrentShop } from "./pending-actions"

/**
 * Home KPI row (spec §8-A5): four real counts + 7-day daily series from
 * the shop's own tables — never estimated, never smoothed. The UI only
 * draws a sparkline when the series has genuine variation; otherwise the
 * plain number renders alone (no fabricated trendlines).
 */

export type KpiSeries = number[] // 7 entries, oldest → today

export type HomeKpis = {
  callsToday: number
  callsSeries: KpiSeries
  leadsToday: number
  leadsSeries: KpiSeries
  bookedToday: number
  bookedSeries: KpiSeries
  needsReview: number
}

const DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

function dayStart(offsetDays: number): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return new Date(d.getTime() - offsetDays * DAY_MS)
}

/** Bucket ISO timestamps into the last 7 local days (oldest → today). */
function bucketByDay(timestamps: string[]): KpiSeries {
  const windowStart = dayStart(DAYS - 1).getTime()
  const series = new Array<number>(DAYS).fill(0)
  for (const iso of timestamps) {
    const t = new Date(iso).getTime()
    if (Number.isNaN(t) || t < windowStart) continue
    const idx = Math.min(DAYS - 1, Math.floor((t - windowStart) / DAY_MS))
    series[idx] += 1
  }
  return series
}

const EMPTY: HomeKpis = {
  callsToday: 0,
  callsSeries: new Array(DAYS).fill(0),
  leadsToday: 0,
  leadsSeries: new Array(DAYS).fill(0),
  bookedToday: 0,
  bookedSeries: new Array(DAYS).fill(0),
  needsReview: 0,
}

export async function getHomeKpis(): Promise<HomeKpis> {
  const shop = await getOptionalShop()
  if (!shop) return EMPTY
  const supabase = await createClient()
  const sinceIso = dayStart(DAYS - 1).toISOString()

  const [callsRes, leadsRes, apptsRes, needsReview] = await Promise.all([
    supabase
      .from("interactions")
      .select("occurred_at, metadata")
      .eq("shop_id", shop.id)
      .eq("channel", "voice")
      .gte("occurred_at", sinceIso),
    supabase
      .from("leads")
      .select("created_at")
      .eq("shop_id", shop.id)
      .gte("created_at", sinceIso),
    supabase
      .from("appointments")
      .select("created_at")
      .eq("shop_id", shop.id)
      .gte("created_at", sinceIso),
    countOpenApprovalsForCurrentShop(),
  ])

  for (const [label, res] of [
    ["calls", callsRes],
    ["leads", leadsRes],
    ["appointments", apptsRes],
  ] as const) {
    if (res.error) console.error(`[data/kpis] ${label} query failed:`, res.error)
  }

  // A call = one distinct vapi_call_id (turns share the id); voice turns
  // without an id count once each — never silently dropped.
  type VoiceTurn = { occurred_at: string; metadata: Record<string, unknown> | null }
  const seenCalls = new Set<string>()
  const callTimestamps: string[] = []
  for (const row of (callsRes.data as VoiceTurn[] | null) ?? []) {
    const callId = row.metadata?.vapi_call_id
    if (typeof callId === "string" && callId) {
      if (seenCalls.has(callId)) continue
      seenCalls.add(callId)
    }
    callTimestamps.push(row.occurred_at)
  }

  const callsSeries = bucketByDay(callTimestamps)
  const leadsSeries = bucketByDay(
    (((leadsRes.data as { created_at: string }[] | null) ?? []).map(
      (r) => r.created_at
    ))
  )
  const bookedSeries = bucketByDay(
    (((apptsRes.data as { created_at: string }[] | null) ?? []).map(
      (r) => r.created_at
    ))
  )

  return {
    callsToday: callsSeries[DAYS - 1],
    callsSeries,
    leadsToday: leadsSeries[DAYS - 1],
    leadsSeries,
    bookedToday: bookedSeries[DAYS - 1],
    bookedSeries,
    needsReview,
  }
}
