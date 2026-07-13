"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { findOrCreateCustomer } from "@/lib/customers"
import { recordInteraction } from "@/lib/memory"
import {
  LOST_REASONS,
  moveLeadToStage,
  nextActionAt,
  type LostReason,
} from "@/lib/pipeline"
import { quotePath } from "@/lib/quotes"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { describeVehicle, vehiclesByCustomerIds } from "@/lib/vehicles"
import type { CrmStage, InteractionRow, QuoteRow } from "@/lib/types/database"

/** Pipeline actions (CRM C2). Owner drag/tap = stage change with history. */

const STAGES: CrmStage[] = [
  "new",
  "needs_quote",
  "quote_sent",
  "follow_up",
  "booked",
  "lost",
]

export type StageMoveResult = { ok: true } | { ok: false; error: string }

export async function setLeadStage(
  leadId: string,
  stage: CrmStage,
  lostReason?: LostReason | null
): Promise<StageMoveResult> {
  if (!STAGES.includes(stage)) return { ok: false, error: "Unknown stage." }
  if (stage === "lost" && (!lostReason || !LOST_REASONS.includes(lostReason))) {
    // Spec C2: an explicit Lost requires a reason — enforced in code.
    return { ok: false, error: "Pick a reason before marking a card lost." }
  }
  const shop = await requireShop()
  await requireUser()
  const supabase = await createClient()
  const moved = await moveLeadToStage(supabase, shop.id, leadId, stage, {
    by: "owner",
    lostReason: lostReason ?? null,
  })
  if (!moved) {
    return {
      ok: false,
      error: "Couldn't move that card (is the C1 migration applied?)",
    }
  }
  revalidatePath("/customers")
  return { ok: true }
}

const quickLeadSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  phone: z.string().trim().min(3, "Phone is required").max(40),
  interest: z.string().trim().max(200).optional(),
})

export type QuickLeadResult = { ok: true; leadId: string } | { ok: false; error: string }

/** New Lead modal — 3 fields, ≤10 seconds (spec C2). */
export async function quickCreateLead(
  input: z.infer<typeof quickLeadSchema>
): Promise<QuickLeadResult> {
  const parsed = quickLeadSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." }
  }
  const shop = await requireShop()
  const supabase = await createClient()

  const customerResult = await findOrCreateCustomer(supabase, shop.id, {
    name: parsed.data.name,
    phone: parsed.data.phone,
  })

  const { data: lead, error } = await supabase
    .from("leads")
    .insert({
      shop_id: shop.id,
      customer_id: customerResult.ok ? customerResult.customer.id : null,
      customer_name: parsed.data.name,
      phone: parsed.data.phone,
      pin_notes: parsed.data.interest || null,
      status: "new",
    })
    .select("id")
    .single()
  if (error || !lead) {
    return { ok: false, error: error?.message ?? "Couldn't save that lead." }
  }
  const leadId = (lead as { id: string }).id

  // Stage + timer + manual source, best-effort (pre-C1 tolerance).
  await moveLeadToStage(supabase, shop.id, leadId, "new", { by: "owner" })
  const { error: srcErr } = await supabase
    .from("leads")
    .update({ source: "manual", next_action_at: nextActionAt("new") })
    .eq("id", leadId)
    .eq("shop_id", shop.id)
  if (srcErr) console.warn("[pipeline] source stamp skipped (pre-C1?):", srcErr.message)

  revalidatePath("/customers")
  return { ok: true, leadId }
}

export type LeadDetail = {
  id: string
  name: string
  phone: string
  email: string | null
  customerId: string | null
  vehicle: string | null
  quote: { id: string; totalCents: number; status: string; publicPath: string | null } | null
  nextActionAt: string | null
  timeline: { id: string; channel: string; role: string; content: string; occurred_at: string }[]
}

/** Slide-over card detail — fetched on open, not with the board. */
export async function getLeadDetail(leadId: string): Promise<LeadDetail | null> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const lead = data as
    | (Record<string, unknown> & {
        id: string
        customer_id: string | null
        customer_name: string
        phone: string
        car_info: string | null
      })
    | null
  if (!lead) return null

  let email: string | null = null
  let vehicle: string | null = lead.car_info
  if (lead.customer_id) {
    const { data: cust } = await supabase
      .from("customers")
      .select("email")
      .eq("id", lead.customer_id)
      .maybeSingle()
    email = (cust as { email: string | null } | null)?.email ?? null
    const vehicles = await vehiclesByCustomerIds(supabase, shop.id, [lead.customer_id])
    vehicle = describeVehicle(vehicles.get(lead.customer_id)?.[0]) ?? lead.car_info
  }

  let quote: LeadDetail["quote"] = null
  const quoteId = (lead as { quote_id?: string | null }).quote_id
  if (quoteId) {
    const { data: q } = await supabase
      .from("quotes")
      .select("id, total_cents, status, public_token")
      .eq("id", quoteId)
      .maybeSingle()
    const row = q as Pick<QuoteRow, "id" | "total_cents" | "status" | "public_token"> | null
    if (row) {
      quote = {
        id: row.id,
        totalCents: row.total_cents,
        status: row.status,
        publicPath: row.public_token ? quotePath(row.public_token) : null,
      }
    }
  }

  let timeline: LeadDetail["timeline"] = []
  if (lead.customer_id) {
    const { data: interactions } = await supabase
      .from("interactions")
      .select("id, channel, role, content, occurred_at")
      .eq("shop_id", shop.id)
      .eq("customer_id", lead.customer_id)
      .order("occurred_at", { ascending: false })
      .limit(12)
    timeline =
      (interactions as Pick<
        InteractionRow,
        "id" | "channel" | "role" | "content" | "occurred_at"
      >[] | null) ?? []
  }

  return {
    id: lead.id,
    name: lead.customer_name,
    phone: lead.phone,
    email,
    customerId: lead.customer_id,
    vehicle,
    quote,
    nextActionAt: ((lead as { next_action_at?: string | null }).next_action_at ?? null),
    timeline,
  }
}

/** Note from the slide-over — lands on the shared timeline. */
export async function addLeadNote(
  leadId: string,
  content: string
): Promise<{ ok: boolean }> {
  const trimmed = content.trim()
  if (!trimmed) return { ok: false }
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("leads")
    .select("customer_id, customer_name")
    .eq("id", leadId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const lead = data as { customer_id: string | null; customer_name: string } | null
  if (!lead) return { ok: false }
  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId: lead.customer_id,
    channel: "note",
    role: "system",
    content: trimmed,
    metadata: { source: "pipeline_card", lead_id: leadId, customer_name: lead.customer_name },
  })
  revalidatePath("/customers")
  return { ok: true }
}
