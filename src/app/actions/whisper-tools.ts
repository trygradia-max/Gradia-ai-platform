"use server"

import { loadShopCreditFields, precheckCredits, recordUsage } from "@/lib/credits"
import { buildDrafterGrounding } from "@/lib/drafting-context"
import { getPricing, priceUsage } from "@/lib/pricing"
import { requireShop } from "@/lib/shop"
import { draftCustomSmsForCustomer } from "@/lib/sms-drafter"
import { createClient } from "@/lib/supabase/server"
import { describeVehicle, vehiclesByCustomerIds } from "@/lib/vehicles"
import {
  buildCustomerFacts,
  summarizeFacts,
} from "@/lib/whisper-summary"
import type { AppointmentRow, QuoteRow } from "@/lib/types/database"

/**
 * Whisper tools (C6b): draft-anywhere + the one-tap customer summary. Both
 * are METERED single-turn workers with a credit pre-check (fail closed) —
 * the persona comes from the same drafters voice/chat use, so surfaces
 * never drift. Neither sends anything: drafts land in the owner's compose
 * box; the summary is read-only.
 */

export type WhisperDraftResult =
  | { ok: true; body: string }
  | { ok: false; error: string }

export async function whisperDraftReply(input: {
  toPhone: string
  customerId?: string | null
}): Promise<WhisperDraftResult> {
  const shop = await requireShop()
  const supabase = await createClient()

  // Fail closed on credits BEFORE the model runs.
  const creditFields = await loadShopCreditFields(supabase, shop.id)
  if (!creditFields) return { ok: false, error: "Set up your shop first." }
  const credit = await precheckCredits(supabase, creditFields, 1)
  if (!credit.ok) return { ok: false, error: credit.reason }

  // Ground the draft in who they are + what they last said (DB only).
  let customerName: string | null = null
  let vehicle: string | null = null
  let lastInbound: string | null = null
  let customerId = input.customerId ?? null
  if (!customerId) {
    const { data } = await supabase
      .from("customers")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("phone", input.toPhone)
      .maybeSingle()
    customerId = (data as { id: string } | null)?.id ?? null
  }
  if (customerId) {
    const { data: cust } = await supabase
      .from("customers")
      .select("name")
      .eq("id", customerId)
      .maybeSingle()
    customerName = (cust as { name: string | null } | null)?.name ?? null
    const vehicles = await vehiclesByCustomerIds(supabase, shop.id, [customerId])
    vehicle = describeVehicle(vehicles.get(customerId)?.[0])
    const { data: inbound } = await supabase
      .from("interactions")
      .select("content")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .eq("role", "customer")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    lastInbound = (inbound as { content: string } | null)?.content ?? null
  }

  const grounding = await buildDrafterGrounding(supabase, shop.id)
  const body = await draftCustomSmsForCustomer({
    shopName: shop.name,
    customerName: customerName ?? "there",
    vehicle,
    service: null,
    intent: lastInbound
      ? `a helpful, specific reply to their last message: "${lastInbound.slice(0, 300)}"`
      : "a warm, helpful check-in that invites them to tell us what they need",
    knowledge: grounding,
  }).catch(() => null)
  if (!body) return { ok: false, error: "Couldn't draft that — try again." }

  const priced = priceUsage(await getPricing(supabase), "outreach_draft", 1)
  await recordUsage(supabase, shop.id, "outreach_draft", {
    quantity: 1,
    credits: priced.credits,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
  })

  return { ok: true, body }
}

export type WhisperSummaryResult =
  | { ok: true; summary: string }
  | { ok: false; error: string }

export async function whisperCustomerSummary(
  customerId: string
): Promise<WhisperSummaryResult> {
  const shop = await requireShop()
  const supabase = await createClient()

  const creditFields = await loadShopCreditFields(supabase, shop.id)
  if (!creditFields) return { ok: false, error: "Set up your shop first." }
  const credit = await precheckCredits(supabase, creditFields, 1)
  if (!credit.ok) return { ok: false, error: credit.reason }

  const { data: custData } = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const customer = custData as
    | (Record<string, unknown> & {
        name: string | null
        do_not_contact: boolean
        lifetime_value_cents?: number
        last_service_at?: string | null
      })
    | null
  if (!customer) return { ok: false, error: "Customer not found." }

  const nowIso = new Date().toISOString()
  const [vehicles, jobsRes, upcomingRes, quotesRes, inboundRes] = await Promise.all([
    vehiclesByCustomerIds(supabase, shop.id, [customerId]),
    supabase
      .from("appointments")
      .select("status, quoted_amount_cents, scheduled_at")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .in("status", ["completed", "paid", "closed"]),
    supabase
      .from("appointments")
      .select("scheduled_at")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .gte("scheduled_at", nowIso)
      .order("scheduled_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("quotes")
      .select("status, total_cents")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .in("status", ["sent", "viewed"]),
    supabase
      .from("interactions")
      .select("channel, occurred_at")
      .eq("shop_id", shop.id)
      .eq("customer_id", customerId)
      .eq("role", "customer")
      .order("occurred_at", { ascending: false })
      .limit(200),
  ])

  const jobs =
    (jobsRes.data as Pick<AppointmentRow, "status" | "quoted_amount_cents" | "scheduled_at">[] | null) ?? []
  const jobsValue = jobs.reduce((sum, j) => sum + (j.quoted_amount_cents ?? 0), 0)
  const lastServiceAt =
    jobs.map((j) => j.scheduled_at).sort().reverse()[0] ??
    (typeof customer.last_service_at === "string" ? customer.last_service_at : null)
  const outstanding =
    (quotesRes.data as Pick<QuoteRow, "status" | "total_cents">[] | null) ?? []
  const inbound =
    (inboundRes.data as { channel: string; occurred_at: string }[] | null) ?? []
  const inboundByChannel: Record<string, number> = {}
  for (const i of inbound) {
    inboundByChannel[i.channel] = (inboundByChannel[i.channel] ?? 0) + 1
  }

  const facts = buildCustomerFacts({
    name: customer.name,
    completedJobsCount: jobs.length,
    lifetimeValueCents: Math.max(
      jobsValue,
      typeof customer.lifetime_value_cents === "number" ? customer.lifetime_value_cents : 0
    ),
    lastServiceAt,
    vehicles: (vehicles.get(customerId) ?? [])
      .map((v) => describeVehicle(v))
      .filter((v): v is string => Boolean(v)),
    upcomingAppointmentAt:
      (upcomingRes.data as { scheduled_at: string } | null)?.scheduled_at ?? null,
    outstandingQuotesCount: outstanding.length,
    outstandingQuotesCents: outstanding.reduce((s, q) => s + q.total_cents, 0),
    inboundByChannel,
    lastInboundAt: inbound[0]?.occurred_at ?? null,
    doNotContact: Boolean(customer.do_not_contact),
  })

  const summary = await summarizeFacts(facts)

  const priced = priceUsage(await getPricing(supabase), "whisper_note", 1)
  await recordUsage(supabase, shop.id, "whisper_note", {
    quantity: 1,
    credits: priced.credits,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
  })

  return { ok: true, summary }
}
