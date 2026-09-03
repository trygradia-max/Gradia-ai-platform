/**
 * Pipeline board data (CRM C2). One query set for the whole board: leads
 * (stage falls back from legacy status pre-migration), quote totals, vehicle
 * display lines, and the ⚡ staged-suggestion marker (a pending approval
 * touching the same person). Read-only.
 */

import { createClient } from "@/lib/supabase/server"
import { stageFromLegacyStatus, PIPELINE_STAGES } from "@/lib/pipeline"
import { requireShop } from "@/lib/shop"
import { shortVehicleLine, vehiclesByCustomerIds } from "@/lib/vehicles"
import type { CrmStage, LeadRow, QuoteRow } from "@/lib/types/database"

export type PipelineCard = {
  id: string
  customerId: string | null
  name: string
  phone: string
  stage: CrmStage
  stageEnteredAt: string | null
  nextActionAt: string | null
  createdAt: string
  vehicle: string | null
  interest: string | null
  quoteId: string | null
  quoteTotalCents: number | null
  estValueCents: number | null
  source: string | null
  lostReason: string | null
  hasStagedSuggestion: boolean
}

export type PipelineData = {
  /** Newest cards per stage, capped at PIPELINE_STAGE_CAP (PERF-001). */
  cards: PipelineCard[]
  /** Totals over ALL cards, capped or not — the numbers stay true (D-025). */
  totals: Record<CrmStage, { count: number; valueCents: number }>
  /** What the cap left out per stage, so the column can say so honestly. */
  hidden: Record<CrmStage, { count: number; valueCents: number }>
}

/**
 * PERF-001: the board rendered every one of the 500 newest leads as a card
 * (2.3 MB of HTML on Customers). A column now draws its newest cards up to
 * this cap and prints "N older" for the rest; stage totals still count them.
 */
export const PIPELINE_STAGE_CAP = 30

type LeadWithC1 = LeadRow & {
  stage?: CrmStage | null
  stage_entered_at?: string | null
  next_action_at?: string | null
  quote_id?: string | null
  est_value_cents?: number | null
  source?: string | null
  lost_reason?: string | null
}

export async function listPipelineForCurrentShop(): Promise<PipelineData> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: leadData, error } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shop.id)
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  const leads = (leadData as LeadWithC1[] | null) ?? []

  // Quote totals for cards that link one (pre-migration: table missing → {}).
  const quoteIds = leads.map((l) => l.quote_id).filter((id): id is string => Boolean(id))
  const quoteById = new Map<string, Pick<QuoteRow, "id" | "total_cents" | "status">>()
  if (quoteIds.length > 0) {
    const { data: quoteData, error: quoteErr } = await supabase
      .from("quotes")
      .select("id, total_cents, status")
      .in("id", quoteIds)
    if (quoteErr) {
      console.warn("[pipeline] quote join skipped (pre-C1?):", quoteErr.message)
    }
    for (const q of (quoteData as Pick<QuoteRow, "id" | "total_cents" | "status">[] | null) ?? []) {
      quoteById.set(q.id, q)
    }
  }

  // Vehicle display via the accessor, car_info as the raw fallback.
  const customerIds = leads
    .map((l) => l.customer_id)
    .filter((id): id is string => Boolean(id))
  const vehicles = await vehiclesByCustomerIds(supabase, shop.id, customerIds)

  // ⚡ marker: any pending approval that references this person.
  const { data: pendingData } = await supabase
    .from("pending_actions")
    .select("payload")
    .eq("shop_id", shop.id)
    .eq("status", "pending")
    .limit(300)
  const pendingPhones = new Set<string>()
  const pendingCustomerIds = new Set<string>()
  for (const row of (pendingData as { payload: Record<string, unknown> }[] | null) ?? []) {
    const phone = row.payload?.phone ?? row.payload?.to_phone
    if (typeof phone === "string" && phone.trim()) {
      pendingPhones.add(phone.replace(/\D/g, "").slice(-10))
    }
    const cid = row.payload?.customer_id
    if (typeof cid === "string") pendingCustomerIds.add(cid)
  }

  const cards: PipelineCard[] = leads.map((l) => {
    const quote = l.quote_id ? quoteById.get(l.quote_id) : undefined
    const phoneKey = l.phone.replace(/\D/g, "").slice(-10)
    return {
      id: l.id,
      customerId: l.customer_id,
      name: l.customer_name,
      phone: l.phone,
      stage: l.stage ?? stageFromLegacyStatus(l.status),
      stageEnteredAt: l.stage_entered_at ?? null,
      nextActionAt: l.next_action_at ?? null,
      createdAt: l.created_at,
      vehicle:
        (l.customer_id
          ? shortVehicleLine(vehicles.get(l.customer_id)?.[0])
          : null) ?? l.car_info,
      interest: l.pin_notes,
      quoteId: l.quote_id ?? null,
      quoteTotalCents: quote?.total_cents ?? null,
      estValueCents: l.est_value_cents ?? null,
      source: l.source ?? null,
      lostReason: l.lost_reason ?? null,
      hasStagedSuggestion:
        (phoneKey.length >= 7 && pendingPhones.has(phoneKey)) ||
        (l.customer_id != null && pendingCustomerIds.has(l.customer_id)),
    }
  })

  return capPipelineCards(cards)
}

/** Pure: totals over every card, then the newest PIPELINE_STAGE_CAP per stage
 *  survive; the remainder is reported per stage. Exported for the unit lock. */
export function capPipelineCards(
  cards: PipelineCard[],
  cap: number = PIPELINE_STAGE_CAP
): PipelineData {
  const empty = () =>
    Object.fromEntries(
      PIPELINE_STAGES.map((s) => [s.key, { count: 0, valueCents: 0 }])
    ) as PipelineData["totals"]
  const totals = empty()
  const hidden = empty()
  const kept: PipelineCard[] = []
  const seen: Partial<Record<CrmStage, number>> = {}
  // `cards` arrive newest-first from the query, so the first `cap` per stage
  // are the newest.
  for (const card of cards) {
    const value = card.quoteTotalCents ?? card.estValueCents ?? 0
    totals[card.stage].count += 1
    totals[card.stage].valueCents += value
    const n = (seen[card.stage] ?? 0) + 1
    seen[card.stage] = n
    if (n <= cap) {
      kept.push(card)
    } else {
      hidden[card.stage].count += 1
      hidden[card.stage].valueCents += value
    }
  }
  return { cards: kept, totals, hidden }
}
