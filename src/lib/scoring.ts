/**
 * Heat Score — pilot-stage lead scoring.
 *
 * Deterministic heuristic, not an ML model. Honest framing: "based on
 * what we've seen" rather than a conversion probability. At pilot
 * scale we don't have enough labeled data to train anything credible;
 * a transparent heuristic is more useful and easier to reason about.
 * The shape lets us swap in a learned model later without changing
 * callers — `computeHeatScore` returns the same {score, label, signals}
 * regardless of what's underneath.
 *
 * Signals (additive, max each):
 *   - lead age (fresher = warmer)         max +30
 *   - lead status (booked highest)         max +40
 *   - recent activity (last 7d)            max +30
 *   - any customer outbound response?      +15 if yes
 *   - past paid invoices (repeat signal)   +15 if any
 *
 * Final score clamped to [0, 100], bucketed:
 *   75+      Hot   🔥
 *   40–74    Warm
 *   0–39     Cold
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { LeadRow, LeadStatus } from "@/lib/types/database"

export type HeatLabel = "hot" | "warm" | "cold"

export type HeatBreakdown = {
  age: number
  status: number
  recent_activity: number
  inbound_response: number
  repeat_customer: number
}

export type HeatScore = {
  score: number
  label: HeatLabel
  breakdown: HeatBreakdown
}

const DAY_MS = 24 * 60 * 60 * 1000

function ageDays(iso: string): number {
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / DAY_MS)
}

function statusPoints(status: LeadStatus): number {
  switch (status) {
    case "booked":
      return 40
    case "quoted":
      return 25
    case "new":
      return 10
    default:
      return 0
  }
}

function agePoints(createdAtIso: string): number {
  const days = ageDays(createdAtIso)
  if (days <= 2) return 30
  if (days <= 7) return 20
  if (days <= 14) return 10
  return 0
}

function activityPoints(recentCount: number): number {
  if (recentCount === 0) return 0
  if (recentCount <= 2) return 10
  if (recentCount <= 5) return 20
  return 30
}

function bucket(score: number): HeatLabel {
  if (score >= 75) return "hot"
  if (score >= 40) return "warm"
  return "cold"
}

/**
 * Shop-level context the per-lead score depends on. Built once per
 * page render via buildHeatContext, then computeHeatScore reads from
 * it in O(1) per lead.
 */
export type HeatContext = {
  recentInteractionsByCustomer: Map<string, number>
  customerHasInboundResponse: Set<string>
  paidInvoiceCustomers: Set<string>
}

export function computeHeatScore(
  lead: LeadRow,
  context: HeatContext
): HeatScore {
  const customerId = lead.customer_id
  const recent = customerId
    ? (context.recentInteractionsByCustomer.get(customerId) ?? 0)
    : 0
  const responded = customerId
    ? context.customerHasInboundResponse.has(customerId)
    : false
  const repeat = customerId
    ? context.paidInvoiceCustomers.has(customerId)
    : false

  const breakdown: HeatBreakdown = {
    age: agePoints(lead.created_at),
    status: statusPoints(lead.status),
    recent_activity: activityPoints(recent),
    inbound_response: responded ? 15 : 0,
    repeat_customer: repeat ? 15 : 0,
  }

  const raw =
    breakdown.age +
    breakdown.status +
    breakdown.recent_activity +
    breakdown.inbound_response +
    breakdown.repeat_customer
  const score = Math.max(0, Math.min(100, raw))

  return { score, label: bucket(score), breakdown }
}

const RECENT_WINDOW_DAYS = 7

/**
 * Bulk-loads everything computeHeatScore needs for a set of leads.
 * Three queries total, regardless of how many leads we're scoring —
 * the (shop_id, customer_id) filters keep them cheap.
 */
export async function buildHeatContext(
  supabase: SupabaseClient,
  shopId: string,
  leads: LeadRow[]
): Promise<HeatContext> {
  const customerIds = Array.from(
    new Set(leads.map((l) => l.customer_id).filter((id): id is string => Boolean(id)))
  )

  const empty: HeatContext = {
    recentInteractionsByCustomer: new Map(),
    customerHasInboundResponse: new Set(),
    paidInvoiceCustomers: new Set(),
  }
  if (customerIds.length === 0) return empty

  const sinceIso = new Date(Date.now() - RECENT_WINDOW_DAYS * DAY_MS).toISOString()

  const [recentInteractionsRes, anyInboundRes, paymentsRes] = await Promise.all([
    supabase
      .from("interactions")
      .select("customer_id, role")
      .eq("shop_id", shopId)
      .in("customer_id", customerIds)
      .gte("occurred_at", sinceIso),
    supabase
      .from("interactions")
      .select("customer_id")
      .eq("shop_id", shopId)
      .eq("role", "customer")
      .in("customer_id", customerIds),
    supabase
      .from("payments")
      .select("customer_id")
      .eq("shop_id", shopId)
      .in("customer_id", customerIds),
  ])

  const recentMap = new Map<string, number>()
  for (const row of (recentInteractionsRes.data as { customer_id: string | null }[] | null) ?? []) {
    if (!row.customer_id) continue
    recentMap.set(row.customer_id, (recentMap.get(row.customer_id) ?? 0) + 1)
  }

  const inboundSet = new Set<string>()
  for (const row of (anyInboundRes.data as { customer_id: string | null }[] | null) ?? []) {
    if (row.customer_id) inboundSet.add(row.customer_id)
  }

  const paidSet = new Set<string>()
  for (const row of (paymentsRes.data as { customer_id: string | null }[] | null) ?? []) {
    if (row.customer_id) paidSet.add(row.customer_id)
  }

  return {
    recentInteractionsByCustomer: recentMap,
    customerHasInboundResponse: inboundSet,
    paidInvoiceCustomers: paidSet,
  }
}
