/**
 * Whisper suggestion generation (C6a, DB side). Rides the automations cron:
 * SQL loads the rows, the pure pickers (whisper-suggestions.ts) choose
 * candidates and write the grounded why, a single-turn drafter writes the
 * copy (METERED per draft, credit pre-check FAIL CLOSED), and each
 * suggestion is staged as a normal send_sms pending action tagged
 * whisper_suggestion — the Today queue reads those; Approve routes through
 * the same executor as every outbound. Idempotent per suggestion ref.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { precheckCredits, recordUsage, type ShopCreditFields } from "@/lib/credits"
import { recordActionDecision } from "@/lib/decision-log"
import { buildDrafterGrounding } from "@/lib/drafting-context"
import { getPricing, priceUsage } from "@/lib/pricing"
import { draftCustomSmsForCustomer } from "@/lib/sms-drafter"
import {
  dedupeCandidates,
  pickFollowUpsDue,
  pickRevivalLeads,
  pickStaleQuotes,
  MAX_SUGGESTIONS_PER_SWEEP,
  type LeadForSuggestion,
  type QuoteForSuggestion,
  type SuggestionCandidate,
} from "@/lib/whisper-suggestions"
import type { CrmStage, QuoteRow, ShopRow } from "@/lib/types/database"

type SweepShop = Pick<
  ShopRow,
  "id" | "owner_id" | "name" | "plan" | "credit_period_start"
>

export type WhisperSweepResult = {
  candidates: number
  staged: number
  skipped_reason?: string
}

export async function runWhisperSuggestionSweep(
  supabase: SupabaseClient,
  shop: SweepShop,
  now: Date = new Date()
): Promise<WhisperSweepResult> {
  const candidates = await loadCandidates(supabase, shop.id, now)
  if (candidates.length === 0) return { candidates: 0, staged: 0 }

  // Once per ref, ever — check against every prior suggestion (any status).
  const { data: prior } = await supabase
    .from("pending_actions")
    .select("payload")
    .eq("shop_id", shop.id)
    .eq("payload->>source", "whisper_suggestion")
    .limit(1000)
  const seen = new Set(
    ((prior as { payload: Record<string, unknown> }[] | null) ?? [])
      .map((r) => String(r.payload?.suggestion_ref ?? ""))
      .filter(Boolean)
  )
  const fresh = candidates.filter((c) => !seen.has(c.ref)).slice(0, MAX_SUGGESTIONS_PER_SWEEP)
  if (fresh.length === 0) return { candidates: candidates.length, staged: 0 }

  // METERED: credit pre-check for the whole batch — fail closed, no drafts.
  const credit = await precheckCredits(supabase, shop as ShopCreditFields, fresh.length)
  if (!credit.ok) {
    return { candidates: candidates.length, staged: 0, skipped_reason: credit.reason }
  }

  const pricing = await getPricing(supabase)
  const grounding = await buildDrafterGrounding(supabase, shop.id)
  let staged = 0

  for (const candidate of fresh) {
    const body = await draftCustomSmsForCustomer({
      shopName: shop.name,
      customerName: candidate.customerName ?? "there",
      vehicle: null,
      service: null,
      intent: candidate.draftIntent,
      knowledge: grounding,
    }).catch(() => null)
    if (!body) continue

    const priced = priceUsage(pricing, "outreach_draft", 1)
    await recordUsage(supabase, shop.id, "outreach_draft", {
      quantity: 1,
      credits: priced.credits,
      wholesaleCost: priced.wholesale_cost,
      retailCost: priced.retail_cost,
    })

    const { data: pending, error } = await supabase
      .from("pending_actions")
      .insert({
        shop_id: shop.id,
        action_type: "send_sms",
        payload: {
          to_phone: candidate.phone,
          body,
          customer_name: candidate.customerName,
          customer_id: candidate.customerId,
          reason: candidate.why,
          category: "marketing",
          source: "whisper_suggestion",
          suggestion_kind: candidate.kind,
          suggestion_ref: candidate.ref,
          lead_id: candidate.leadId,
          why: candidate.why,
        },
        requested_by: shop.owner_id,
      })
      .select("id")
      .single()
    if (error || !pending) continue

    // Glass Box: the because IS the grounded why.
    await recordActionDecision(supabase, {
      shopId: shop.id,
      pendingActionId: (pending as { id: string }).id,
      source: "whisper",
      because: candidate.why,
      inputs: { rule: `whisper_${candidate.kind}`, suggestion_ref: candidate.ref },
    })
    staged += 1
  }

  return { candidates: candidates.length, staged }
}

/** SQL → pure pickers. Every fact the why cites comes from these rows. */
async function loadCandidates(
  supabase: SupabaseClient,
  shopId: string,
  now: Date
): Promise<SuggestionCandidate[]> {
  // Quotes with their customer contact.
  const { data: quoteData, error: quoteErr } = await supabase
    .from("quotes")
    .select("id, status, sent_at, viewed_at, responded_at, total_cents, customer_id, lead_id, customers(name, phone)")
    .eq("shop_id", shopId)
    .in("status", ["sent", "viewed"])
    .limit(200)
  if (quoteErr) {
    // Pre-C1 DB — quotes table missing; leads-based suggestions still work.
    console.warn("[whisper-sweep] quotes skipped (pre-C1?):", quoteErr.message)
  }
  const quotes: QuoteForSuggestion[] = (
    (quoteData as (Pick<
      QuoteRow,
      "id" | "status" | "sent_at" | "viewed_at" | "responded_at" | "total_cents" | "customer_id" | "lead_id"
    > & { customers: { name: string | null; phone: string | null } | null })[] | null) ?? []
  ).map((q) => ({
    id: q.id,
    status: q.status,
    sent_at: q.sent_at,
    viewed_at: q.viewed_at,
    responded_at: q.responded_at,
    total_cents: q.total_cents,
    customer_id: q.customer_id,
    lead_id: q.lead_id,
    customer_name: q.customers?.name ?? null,
    customer_phone: q.customers?.phone ?? null,
  }))

  // Leads + their interaction recency (two bulk queries, joined in code).
  const { data: leadData } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(300)
  type LeadRowLite = {
    id: string
    customer_id: string | null
    customer_name: string
    phone: string
    stage?: CrmStage | null
    status: string
    next_action_at?: string | null
    created_at: string
  }
  const leadRows = (leadData as LeadRowLite[] | null) ?? []
  const customerIds = [
    ...new Set(leadRows.map((l) => l.customer_id).filter((x): x is string => Boolean(x))),
  ]
  const lastInbound = new Map<string, string>()
  const lastActivity = new Map<string, string>()
  if (customerIds.length > 0) {
    const { data: interData } = await supabase
      .from("interactions")
      .select("customer_id, role, occurred_at")
      .eq("shop_id", shopId)
      .in("customer_id", customerIds)
      .order("occurred_at", { ascending: false })
      .limit(2000)
    for (const row of (interData as { customer_id: string | null; role: string; occurred_at: string }[] | null) ?? []) {
      if (!row.customer_id) continue
      if (!lastActivity.has(row.customer_id)) lastActivity.set(row.customer_id, row.occurred_at)
      if (row.role === "customer" && !lastInbound.has(row.customer_id)) {
        lastInbound.set(row.customer_id, row.occurred_at)
      }
    }
  }

  const leads: LeadForSuggestion[] = leadRows.map((l) => ({
    id: l.id,
    customer_id: l.customer_id,
    customer_name: l.customer_name,
    phone: l.phone,
    stage: l.stage ?? null,
    next_action_at: l.next_action_at ?? null,
    created_at: l.created_at,
    last_inbound_at: l.customer_id ? (lastInbound.get(l.customer_id) ?? null) : null,
    last_activity_at: l.customer_id ? (lastActivity.get(l.customer_id) ?? null) : null,
  }))

  return dedupeCandidates([
    ...pickStaleQuotes(quotes, now),
    ...pickFollowUpsDue(leads, now),
    ...pickRevivalLeads(leads, now),
  ])
}
