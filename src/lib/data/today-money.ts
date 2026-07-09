/**
 * Today money + leak rows (CRM C8) — every number is SQL/code over real
 * rows, no estimates and no model anywhere (ROI-receipt under-claim
 * discipline). Attribution counts ONLY automation-touched leads that are
 * now booked AND carry a real quote total — under-claiming by design.
 */

import { createClient } from "@/lib/supabase/server"
import { startOfWeek } from "@/lib/data/calendar"
import { requireShop } from "@/lib/shop"
import { stageFromLegacyStatus } from "@/lib/pipeline"
import type { CrmStage, QuoteRow } from "@/lib/types/database"

export type TodayMoney = {
  bookedThisWeekCents: number
  completedThisWeekCents: number
  pipelineValueCents: number
  quotesOutstandingCents: number
  quotesOutstandingCount: number
}

export type TodayLeaks = {
  newLeadsToday: number
  newLeadsThisWeek: number
  lostThisWeek: number
  topLostReason: string | null
  reviewRequestsPending: number
}

export type AutomationAttribution = {
  /** Automation-touched leads now booked, this month. */
  bookedCount: number
  /** Sum of those leads' quote totals — only real quote money counts. */
  bookedCents: number
}

export type TodayMoneyData = {
  money: TodayMoney
  leaks: TodayLeaks
  attribution: AutomationAttribution
}

/** Pure: attribution join, testable without a DB (under-claim rules). */
export function summarizeAttribution(
  runs: { lead_id: string | null }[],
  leadStageById: Map<string, CrmStage>,
  leadQuoteCentsById: Map<string, number>
): AutomationAttribution {
  const touched = [...new Set(runs.map((r) => r.lead_id).filter((x): x is string => Boolean(x)))]
  let bookedCount = 0
  let bookedCents = 0
  for (const leadId of touched) {
    if (leadStageById.get(leadId) !== "booked") continue
    const cents = leadQuoteCentsById.get(leadId)
    if (!cents || cents <= 0) continue // no real quote money → don't claim it
    bookedCount += 1
    bookedCents += cents
  }
  return { bookedCount, bookedCents }
}

export async function loadTodayMoney(): Promise<TodayMoneyData> {
  const shop = await requireShop()
  const supabase = await createClient()

  const now = new Date()
  const weekStart = startOfWeek(now).toISOString()
  const dayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const [bookedRes, completedRes, leadsRes, quotesRes, lostRes, reviewRes, runsRes] =
    await Promise.all([
      // Booked this week: jobs created this week, with a quoted amount.
      supabase
        .from("appointments")
        .select("quoted_amount_cents, internal_note")
        .eq("shop_id", shop.id)
        .gte("created_at", weekStart),
      // Completed this week: exact status transitions from the timeline.
      supabase
        .from("interactions")
        .select("metadata")
        .eq("shop_id", shop.id)
        .eq("metadata->>kind", "job_status")
        .eq("metadata->>to", "completed")
        .gte("occurred_at", weekStart),
      supabase
        .from("leads")
        .select("id, status, created_at")
        .eq("shop_id", shop.id)
        .gte("created_at", weekStart)
        .limit(1000),
      supabase
        .from("quotes")
        .select("total_cents, status")
        .eq("shop_id", shop.id)
        .in("status", ["sent", "viewed"]),
      supabase
        .from("leads")
        .select("lost_reason")
        .eq("shop_id", shop.id)
        .eq("stage", "lost")
        .gte("stage_entered_at", weekStart),
      supabase
        .from("automation_runs")
        .select("status, automations!inner(catalog_key)")
        .eq("shop_id", shop.id)
        .eq("status", "staged")
        .eq("automations.catalog_key", "review_request"),
      supabase
        .from("automation_runs")
        .select("lead_id")
        .eq("shop_id", shop.id)
        .gte("created_at", monthStart)
        .limit(2000),
    ])

  // Money row — every leg tolerates pre-C1 (missing tables → zeros).
  const bookedJobs =
    (bookedRes.data as { quoted_amount_cents: number | null; internal_note: string | null }[] | null) ?? []
  const bookedThisWeekCents = bookedJobs
    .filter((j) => j.internal_note !== "[block-time]")
    .reduce((s, j) => s + (j.quoted_amount_cents ?? 0), 0)

  const completedIds = (
    (completedRes.data as { metadata: Record<string, unknown> }[] | null) ?? []
  )
    .map((r) => String(r.metadata?.appointment_id ?? ""))
    .filter(Boolean)
  let completedThisWeekCents = 0
  if (completedIds.length > 0) {
    const { data: completedJobs } = await supabase
      .from("appointments")
      .select("quoted_amount_cents")
      .in("id", completedIds)
    completedThisWeekCents = (
      (completedJobs as { quoted_amount_cents: number | null }[] | null) ?? []
    ).reduce((s, j) => s + (j.quoted_amount_cents ?? 0), 0)
  }

  // Pipeline value: live-stage cards' linked quote totals (or est value).
  const { data: allLeads } = await supabase
    .from("leads")
    .select("id, status, stage, quote_id, est_value_cents")
    .eq("shop_id", shop.id)
    .limit(1000)
  type LeadLite = {
    id: string
    status: string
    stage?: CrmStage | null
    quote_id?: string | null
    est_value_cents?: number | null
  }
  const leads = (allLeads as LeadLite[] | null) ?? []
  const live: CrmStage[] = ["new", "needs_quote", "quote_sent", "follow_up"]
  const liveLeads = leads.filter((l) =>
    live.includes(l.stage ?? stageFromLegacyStatus(l.status))
  )
  const quoteIds = liveLeads.map((l) => l.quote_id).filter((x): x is string => Boolean(x))
  const quoteCents = new Map<string, number>()
  if (quoteIds.length > 0) {
    const { data: q } = await supabase
      .from("quotes")
      .select("id, total_cents")
      .in("id", quoteIds)
    for (const row of (q as Pick<QuoteRow, "id" | "total_cents">[] | null) ?? []) {
      quoteCents.set(row.id, row.total_cents)
    }
  }
  const pipelineValueCents = liveLeads.reduce(
    (s, l) => s + (l.quote_id ? (quoteCents.get(l.quote_id) ?? 0) : (l.est_value_cents ?? 0)),
    0
  )

  const outstanding =
    (quotesRes.data as Pick<QuoteRow, "total_cents" | "status">[] | null) ?? []

  // Leak row.
  const weekLeads =
    (leadsRes.data as { id: string; created_at: string }[] | null) ?? []
  const lost = (lostRes.data as { lost_reason: string | null }[] | null) ?? []
  const reasonCounts = new Map<string, number>()
  for (const l of lost) {
    const r = l.lost_reason ?? "other"
    reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1)
  }
  const topLostReason =
    [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  // Attribution (this month) — the retention line, under-claimed.
  const runs = (runsRes.data as { lead_id: string | null }[] | null) ?? []
  const runLeadIds = [
    ...new Set(runs.map((r) => r.lead_id).filter((x): x is string => Boolean(x))),
  ]
  const stageById = new Map<string, CrmStage>()
  const quoteCentsByLead = new Map<string, number>()
  if (runLeadIds.length > 0) {
    const { data: touchedLeads } = await supabase
      .from("leads")
      .select("id, status, stage, quote_id")
      .in("id", runLeadIds)
    const touched = (touchedLeads as LeadLite[] | null) ?? []
    const touchedQuoteIds = touched
      .map((l) => l.quote_id)
      .filter((x): x is string => Boolean(x))
    const touchedQuoteCents = new Map<string, number>()
    if (touchedQuoteIds.length > 0) {
      const { data: tq } = await supabase
        .from("quotes")
        .select("id, total_cents")
        .in("id", touchedQuoteIds)
      for (const row of (tq as Pick<QuoteRow, "id" | "total_cents">[] | null) ?? []) {
        touchedQuoteCents.set(row.id, row.total_cents)
      }
    }
    for (const l of touched) {
      stageById.set(l.id, l.stage ?? stageFromLegacyStatus(l.status))
      if (l.quote_id) {
        quoteCentsByLead.set(l.id, touchedQuoteCents.get(l.quote_id) ?? 0)
      }
    }
  }

  return {
    money: {
      bookedThisWeekCents,
      completedThisWeekCents,
      pipelineValueCents,
      quotesOutstandingCents: outstanding.reduce((s, q) => s + q.total_cents, 0),
      quotesOutstandingCount: outstanding.length,
    },
    leaks: {
      newLeadsToday: weekLeads.filter((l) => l.created_at >= dayStart).length,
      newLeadsThisWeek: weekLeads.length,
      lostThisWeek: lost.length,
      topLostReason,
      reviewRequestsPending:
        ((reviewRes.data as unknown[] | null) ?? []).length,
    },
    attribution: summarizeAttribution(runs, stageById, quoteCentsByLead),
  }
}
