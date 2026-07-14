/**
 * Read-only business-intelligence tools for the BI chat surface.
 *
 * Each tool: a name + description (which the model uses to pick),
 * a zod schema for the input, and a handler that runs against a
 * SupabaseClient already scoped to the current shop.
 *
 * Constraints baked in:
 *   - Read-only — no inserts/updates/deletes anywhere here.
 *   - Shop-scoped — every query filters on shop_id.
 *   - Bounded — caps on `days_back` and `limit` so the model can't
 *     ask for runaway results.
 *
 * No revenue tools yet — Stripe charge amounts live in invoice
 * objects on the connected account, not in our DB. Mirroring those
 * is its own task; until then we just don't expose money to BI.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { buildLookupOutcome, findPeopleInCrm } from "@/lib/find-person"
import { searchShopKnowledge } from "@/lib/knowledge"
import { searchCustomerMemory } from "@/lib/memory"
import {
  buildHeatContext,
  computeHeatScore,
  type HeatLabel,
} from "@/lib/scoring"
import type {
  InteractionChannel,
  LeadRow,
  LeadStatus,
  ShopRow,
} from "@/lib/types/database"

function isoDaysBack(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function isoDaysAhead(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

// ---------- tool schemas ----------

const countLeadsSchema = z.object({
  status: z
    .enum(["new", "quoted", "booked"])
    .optional()
    .describe("Filter by lead status. Omit for all statuses."),
  days_back: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Only count leads created in the last N days. Omit for all-time."),
})

const recentLeadsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("How many leads to return, newest first."),
  status: z
    .enum(["new", "quoted", "booked"])
    .optional()
    .describe("Filter by status. Omit for any."),
})

const customerCountSchema = z.object({
  days_back: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Count customers added in the last N days. Omit for all-time total."),
})

const channelVolumeSchema = z.object({
  days_back: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe("Window for the volume rollup."),
})

const upcomingAppointmentsSchema = z.object({
  days_ahead: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(7)
    .describe("How many days into the future to look."),
})

const findPersonSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(120)
    .describe("Name (or part of one) or phone digits to look up"),
})

const searchMemorySchema = z.object({
  query: z
    .string()
    .min(2)
    .max(400)
    .describe(
      "Free-text question to search across customer touchpoints. Used for 'what did Sam ask about?', 'who mentioned ceramic this week?', etc."
    ),
  limit: z.number().int().min(1).max(20).default(5),
})

const searchKnowledgeSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(400)
    .describe(
      "Free-text question to look up in the shop's knowledge base (FAQs, policies, brand voice, deposit rules, etc.). Use when the owner asks about how the shop operates rather than what customers have done."
    ),
  limit: z.number().int().min(1).max(10).default(4),
})

const revenueSchema = z.object({
  days_back: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "Revenue from invoices paid in the last N days. Omit for all-time total."
    ),
})

const topHeatSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe("How many of the hottest leads to return, hottest first."),
  min_label: z
    .enum(["hot", "warm", "cold"])
    .optional()
    .describe(
      "Lowest temperature to include. Omit for all leads. 'hot' returns only hot leads, 'warm' returns hot + warm."
    ),
})

// ---------- handlers ----------

async function countLeads(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof countLeadsSchema>
) {
  let q = supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
  if (params.status) q = q.eq("status", params.status as LeadStatus)
  if (params.days_back) q = q.gte("created_at", isoDaysBack(params.days_back))
  const { count, error } = await q
  if (error) throw new Error(`count_leads: ${error.message}`)
  return {
    count: count ?? 0,
    status: params.status ?? "any",
    window:
      params.days_back !== undefined ? `last ${params.days_back} days` : "all time",
  }
}

async function recentLeads(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof recentLeadsSchema>
) {
  let q = supabase
    .from("leads")
    .select(
      "id, customer_name, phone, car_info, pin_notes, status, created_at"
    )
    .eq("shop_id", shopId)
  if (params.status) q = q.eq("status", params.status as LeadStatus)
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(params.limit)
  if (error) throw new Error(`recent_leads: ${error.message}`)
  return { leads: data ?? [] }
}

async function customerCount(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof customerCountSchema>
) {
  let q = supabase
    .from("customers")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
  if (params.days_back) q = q.gte("created_at", isoDaysBack(params.days_back))
  const { count, error } = await q
  if (error) throw new Error(`customer_count: ${error.message}`)
  return {
    count: count ?? 0,
    window:
      params.days_back !== undefined ? `last ${params.days_back} days` : "all time",
  }
}

async function channelVolume(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof channelVolumeSchema>
) {
  const since = isoDaysBack(params.days_back)
  const { data, error } = await supabase
    .from("interactions")
    .select("channel")
    .eq("shop_id", shopId)
    .gte("occurred_at", since)
  if (error) throw new Error(`channel_volume: ${error.message}`)

  const rollup: Record<string, number> = {}
  for (const row of (data as { channel: InteractionChannel }[] | null) ?? []) {
    rollup[row.channel] = (rollup[row.channel] ?? 0) + 1
  }
  return {
    window: `last ${params.days_back} days`,
    by_channel: rollup,
    total: Object.values(rollup).reduce((a, b) => a + b, 0),
  }
}

async function upcomingAppointments(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof upcomingAppointmentsSchema>
) {
  const nowIso = new Date().toISOString()
  const untilIso = isoDaysAhead(params.days_ahead)
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, duration_minutes, service_name, customer_id, lead_id"
    )
    .eq("shop_id", shopId)
    .gte("scheduled_at", nowIso)
    .lt("scheduled_at", untilIso)
    .order("scheduled_at", { ascending: true })
  if (error) throw new Error(`upcoming_appointments: ${error.message}`)
  return {
    window: `next ${params.days_ahead} days`,
    appointments: data ?? [],
  }
}

function meetsHeatThreshold(
  label: HeatLabel,
  min: HeatLabel | undefined
): boolean {
  if (!min) return true
  const order: HeatLabel[] = ["cold", "warm", "hot"]
  return order.indexOf(label) >= order.indexOf(min)
}

async function topHeatLeads(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof topHeatSchema>
) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shopId)
    .neq("status", "booked")
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new Error(`top_heat_leads: ${error.message}`)
  const leads = (data as LeadRow[] | null) ?? []
  if (leads.length === 0) {
    return { matches: [], window: "active leads (excluding booked)" }
  }

  const context = await buildHeatContext(supabase, shopId, leads)
  const scored = leads
    .map((lead) => ({ lead, heat: computeHeatScore(lead, context) }))
    .filter((r) => meetsHeatThreshold(r.heat.label, params.min_label))
    .sort((a, b) => b.heat.score - a.heat.score)
    .slice(0, params.limit)
    .map((r) => ({
      lead_id: r.lead.id,
      customer_name: r.lead.customer_name,
      phone: r.lead.phone,
      status: r.lead.status,
      car_info: r.lead.car_info,
      pin_notes: r.lead.pin_notes,
      created_at: r.lead.created_at,
      heat_score: r.heat.score,
      heat_label: r.heat.label,
    }))

  return { matches: scored, window: "active leads (excluding booked)" }
}

async function revenueInWindow(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof revenueSchema>
) {
  let q = supabase
    .from("payments")
    .select("amount_cents, refunded_amount_cents, paid_at")
    .eq("shop_id", shopId)
  if (params.days_back) {
    q = q.gte("paid_at", isoDaysBack(params.days_back))
  }
  const { data, error } = await q
  if (error) throw new Error(`revenue_in_window: ${error.message}`)
  const rows =
    (data as {
      amount_cents: number
      refunded_amount_cents: number | null
      paid_at: string
    }[] | null) ?? []
  const totalCents = rows.reduce(
    (sum, r) =>
      sum + Math.max(0, (r.amount_cents ?? 0) - (r.refunded_amount_cents ?? 0)),
    0
  )
  const refundedCents = rows.reduce(
    (sum, r) => sum + (r.refunded_amount_cents ?? 0),
    0
  )
  return {
    total_cents: totalCents,
    total_usd: (totalCents / 100).toFixed(2),
    refunded_cents: refundedCents,
    refunded_usd: (refundedCents / 100).toFixed(2),
    invoice_count: rows.length,
    window:
      params.days_back !== undefined
        ? `last ${params.days_back} days`
        : "all time",
  }
}

async function findPerson(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof findPersonSchema>
) {
  // Deterministic SQL across BOTH leads and customers — a lead with zero
  // conversation history is still found (fix-pass 2026-07-13 P0). The
  // outcome copy is decided by code: honest miss / unique hit / fact-based
  // disambiguation. Never ask for a phone when a unique name match exists.
  const matches = await findPeopleInCrm(supabase, shopId, params.query)
  const outcome = buildLookupOutcome(params.query, matches)
  return {
    outcome: outcome.outcome,
    guidance: outcome.say,
    matches: matches.slice(0, 6).map((m) => ({
      source: m.source,
      lead_id: m.source === "lead" ? m.id : null,
      customer_id: m.source === "customer" ? m.id : m.customerId,
      name: m.name,
      phone: m.phone,
      email: m.email,
      vehicle: m.vehicle,
      pipeline: m.stage,
      note: m.note,
    })),
  }
}

async function searchMemory(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof searchMemorySchema>
) {
  try {
    // null customerId = shop-wide search across every customer.
    const results = await searchCustomerMemory(
      supabase,
      shopId,
      null,
      params.query,
      { limit: params.limit }
    )
    if (results.length === 0) {
      return {
        query: params.query,
        matches: [],
        // Honest-miss contract (fix-pass 2026-07-13): an empty result is a
        // MISS, never a malfunction. The model must not invent connection
        // or system excuses, and must not conclude a person doesn't exist.
        note: "No recorded conversations matched. This is a normal empty result — NOT a system or connection problem. It also does not mean the person is missing from the CRM: use find_person to check that.",
      }
    }
    return { query: params.query, matches: results }
  } catch (err) {
    console.error("[bi-tools] search_memory failed:", err)
    return {
      query: params.query,
      matches: [],
      // A REAL failure — say exactly this much and no more.
      error: "The conversation search failed on our side just now — tell the owner that plainly. Do not speculate about causes.",
    }
  }
}

async function searchKnowledge(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof searchKnowledgeSchema>
) {
  const matches = await searchShopKnowledge(supabase, shopId, params.query, {
    limit: params.limit,
  })
  return { query: params.query, matches }
}

// ---------- Setup Engineer tools ----------
//
// These three turn the BI chat into a setup assistant. The agent can
// inspect what's wired (check_setup_status), recommend the highest-
// leverage next channel for a detail shop (recommend_next_setup), and
// hand the operator a deep link to the right settings card
// (link_to_setup). Provisioning itself still happens via the existing
// settings UI — the agent guides; the operator drives.

const checkSetupStatusSchema = z.object({})

const recommendNextSetupSchema = z.object({})

const linkToSetupSchema = z.object({
  channel: z
    .enum([
      "voice",
      "email",
      "sms",
      "payments",
      "knowledge",
      "services",
    ])
    .describe("Which channel / area to deep-link the operator to."),
})

type ChannelStatus = {
  channel: string
  connected: boolean
  /** Human-readable label of the connection target (e.g. "+1 (617) 555-0142"). */
  detail: string | null
  /** Why we say it's "connected" or "not" — feeds the agent's narration. */
  reason: string
}

async function loadShopRow(
  supabase: SupabaseClient,
  shopId: string
): Promise<ShopRow | null> {
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopId)
    .single()
  return (data as ShopRow | null) ?? null
}

async function checkSetupStatus(
  supabase: SupabaseClient,
  shopId: string
): Promise<{
  shopName: string | null
  channels: ChannelStatus[]
  servicesCount: number
  knowledgeCount: number
  connectedCount: number
  totalChannels: number
}> {
  const shop = await loadShopRow(supabase, shopId)
  const [{ count: servicesCount }, { count: knowledgeCount }] =
    await Promise.all([
      supabase
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId),
      supabase
        .from("shop_knowledge")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shopId),
    ])

  const channels: ChannelStatus[] = [
    {
      channel: "voice",
      connected: Boolean(shop?.vapi_assistant_id),
      detail: shop?.vapi_assistant_id ?? null,
      reason: shop?.vapi_assistant_id
        ? "Vapi voice receptionist is provisioned."
        : "No Vapi assistant on file yet — build one in Settings → Voice.",
    },
    {
      channel: "email",
      connected: Boolean(
        shop?.aurinko_access_token_enc && shop?.aurinko_account_id
      ),
      detail: shop?.aurinko_account_email ?? null,
      reason:
        shop?.aurinko_access_token_enc && shop?.aurinko_account_id
          ? "Gmail (via Aurinko) is connected."
          : "Gmail isn't connected yet — connect via Settings → Email.",
    },
    {
      channel: "sms",
      connected: Boolean(shop?.twilio_phone_number),
      detail: shop?.twilio_phone_number ?? null,
      reason: shop?.twilio_phone_number
        ? "Twilio number is wired up for inbound + outbound SMS."
        : "No SMS number yet — pick one in Settings → SMS.",
    },
    {
      channel: "payments",
      connected: Boolean(shop?.stripe_account_id),
      detail: shop?.stripe_account_id ?? null,
      reason: shop?.stripe_charges_enabled
        ? "Stripe Connect is live — invoices can ship."
        : shop?.stripe_account_id
          ? "Stripe account exists but charges aren't enabled yet — finish onboarding in Settings → Payments."
          : "No Stripe Connect account yet — connect via Settings → Payments.",
    },
    {
      channel: "calendar",
      connected: Boolean(
        shop?.aurinko_access_token_enc && shop?.aurinko_account_id
      ),
      detail: null,
      reason:
        shop?.aurinko_access_token_enc && shop?.aurinko_account_id
          ? "Google Calendar inherits from the Gmail connection."
          : "Calendar lights up automatically when Gmail is connected.",
    },
  ]
  const connectedCount = channels.filter((c) => c.connected).length

  return {
    shopName: shop?.name ?? null,
    channels,
    servicesCount: servicesCount ?? 0,
    knowledgeCount: knowledgeCount ?? 0,
    connectedCount,
    totalChannels: channels.length,
  }
}

async function recommendNextSetup(
  supabase: SupabaseClient,
  shopId: string
): Promise<{
  /** Highest-leverage next move, or null when everything's wired. */
  next: { channel: string; reason: string } | null
  /** Everything missing, in priority order, for context. */
  missing: { channel: string; reason: string }[]
  /** Short paragraph the agent can paraphrase. */
  summary: string
}> {
  const status = await checkSetupStatus(supabase, shopId)

  // Priority order tuned for detail shops:
  //   1. services    — without these the voice agent can't quote
  //   2. voice       — biggest lead capture, runs while shop is busy
  //   3. sms         — second-biggest, plus the only outbound the AI
  //                    handles unattended
  //   4. payments    — needed before any "charge" action can fire
  //   5. email       — Gmail + Calendar (lower volume than voice/sms but
  //                    still essential)
  //   6. knowledge   — quality lever, can come later
  const PRIORITY: { channel: string; reason: string }[] = []
  if (status.servicesCount === 0) {
    PRIORITY.push({
      channel: "services",
      reason:
        "Add at least one service so the voice + chat agents can quote prices.",
    })
  }
  for (const c of status.channels) {
    if (c.channel === "calendar") continue // inherits from email
    if (!c.connected) PRIORITY.push({ channel: c.channel, reason: c.reason })
  }
  // Knowledge is "missing" only if zero entries — it's a soft lever, not
  // a hard blocker, so it goes last.
  if (status.knowledgeCount === 0) {
    PRIORITY.push({
      channel: "knowledge",
      reason:
        "Paste in your shop policies — deposit rules, weather policy, hours — so the agents quote your actual words.",
    })
  }

  const priorityOrder = [
    "services",
    "voice",
    "sms",
    "payments",
    "email",
    "knowledge",
  ]
  const missing = PRIORITY.sort(
    (a, b) =>
      priorityOrder.indexOf(a.channel) - priorityOrder.indexOf(b.channel)
  )

  const next = missing[0] ?? null
  const shopLabel = status.shopName?.trim()
    ? status.shopName
    : "the shop"
  const summary =
    missing.length === 0
      ? `${shopLabel} is fully wired — ${status.connectedCount} of ${status.totalChannels} channels live, ${status.servicesCount} services on file.`
      : `${status.connectedCount} of ${status.totalChannels} channels live. Highest-leverage next move: ${next?.channel} — ${next?.reason}`

  return { next, missing, summary }
}

const SETUP_LINKS: Record<
  z.infer<typeof linkToSetupSchema>["channel"],
  { path: string; label: string; cta: string }
> = {
  voice: {
    path: "/settings#voice",
    label: "Voice receptionist",
    cta: "Build the receptionist",
  },
  email: {
    path: "/settings#email",
    label: "Email + Calendar (Gmail)",
    cta: "Connect Gmail",
  },
  sms: {
    path: "/settings#sms",
    label: "SMS receptionist",
    cta: "Pick a Gradia number",
  },
  payments: {
    path: "/settings#payments",
    label: "Payments (Stripe)",
    cta: "Connect Stripe",
  },
  knowledge: {
    path: "/settings#knowledge",
    label: "Shop knowledge",
    cta: "Paste your policies",
  },
  services: {
    path: "/onboarding",
    label: "Service menu",
    cta: "Add a service",
  },
}

async function linkToSetup(
  params: z.infer<typeof linkToSetupSchema>
): Promise<{
  channel: z.infer<typeof linkToSetupSchema>["channel"]
  path: string
  label: string
  cta: string
  markdownLink: string
}> {
  const link = SETUP_LINKS[params.channel]
  return {
    channel: params.channel,
    path: link.path,
    label: link.label,
    cta: link.cta,
    /** Pre-formatted markdown link the agent can paste into its reply. */
    markdownLink: `[${link.cta}](${link.path})`,
  }
}

// ---------- registry ----------

export type BiToolHandler = (
  supabase: SupabaseClient,
  shopId: string,
  params: unknown
) => Promise<unknown>

export type BiToolDefinition = {
  name: string
  description: string
  schema: z.ZodTypeAny
  handler: BiToolHandler
}

const coldLeadsSchema = z.object({
  min_age_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(14)
    .describe("only leads at least this many days old"),
  limit: z.number().int().min(1).max(50).default(20),
})

/**
 * Revival candidates: leads that never booked and have been sitting. Oldest
 * first (coldest). Backs "find cold leads to revive" — the diagnose half of a
 * win-back. Read-only.
 */
async function coldLeads(
  supabase: SupabaseClient,
  shopId: string,
  params: z.infer<typeof coldLeadsSchema>
) {
  const { data, error } = await supabase
    .from("leads")
    .select("id, customer_name, phone, car_info, status, created_at")
    .eq("shop_id", shopId)
    .neq("status", "booked")
    .lte("created_at", isoDaysBack(params.min_age_days))
    .order("created_at", { ascending: true })
    .limit(params.limit)
  if (error) throw new Error(`cold_leads: ${error.message}`)
  const leads = (data as LeadRow[] | null) ?? []
  return {
    count: leads.length,
    window: `new/quoted leads with no booking, at least ${params.min_age_days} days old`,
    matches: leads.map((l) => ({
      lead_id: l.id,
      customer_name: l.customer_name,
      phone: l.phone,
      car_info: l.car_info,
      status: l.status,
      created_at: l.created_at,
    })),
  }
}

export const BI_TOOLS: BiToolDefinition[] = [
  {
    name: "count_leads",
    description:
      "Count leads in our pipeline. Use for 'how many leads this week / today / month', 'how many quoted', etc.",
    schema: countLeadsSchema,
    handler: (supabase, shopId, params) =>
      countLeads(supabase, shopId, countLeadsSchema.parse(params)),
  },
  {
    name: "recent_leads",
    description:
      "List the most recent N leads with their details. Use for 'show me the latest leads', 'who came in today'.",
    schema: recentLeadsSchema,
    handler: (supabase, shopId, params) =>
      recentLeads(supabase, shopId, recentLeadsSchema.parse(params)),
  },
  {
    name: "customer_count",
    description:
      "Count customers in our shop. Use for 'how many customers do we have', 'how many new customers this month'.",
    schema: customerCountSchema,
    handler: (supabase, shopId, params) =>
      customerCount(supabase, shopId, customerCountSchema.parse(params)),
  },
  {
    name: "channel_volume",
    description:
      "Roll up interactions per channel over a window. Use for 'how much voice this month', 'are we getting more email or SMS', 'channel breakdown'.",
    schema: channelVolumeSchema,
    handler: (supabase, shopId, params) =>
      channelVolume(supabase, shopId, channelVolumeSchema.parse(params)),
  },
  {
    name: "upcoming_appointments",
    description:
      "List upcoming appointments in the next N days. Use for 'what's on the books tomorrow', 'how busy is next week'.",
    schema: upcomingAppointmentsSchema,
    handler: (supabase, shopId, params) =>
      upcomingAppointments(
        supabase,
        shopId,
        upcomingAppointmentsSchema.parse(params)
      ),
  },
  {
    name: "find_person",
    description:
      "ALWAYS the first stop to find a specific person by name or phone ('find mike', 'do we have a Sara?'). Deterministic CRM lookup across BOTH leads and customers — works even when there's no conversation history. Returns the match(es) with facts on file plus exact guidance copy: repeat `guidance` to the owner on a miss or a multi-match instead of writing your own.",
    schema: findPersonSchema,
    handler: (supabase, shopId, params) =>
      findPerson(supabase, shopId, findPersonSchema.parse(params)),
  },
  {
    name: "search_memory",
    description:
      "Semantic search over recorded conversation content — for WHAT someone said ('what did Sam ask about?', 'who mentioned ceramic this week?'). NOT for finding whether a person exists: use find_person for that — this search misses anyone with no recorded conversations, and an empty result here never means the person is missing from the CRM.",
    schema: searchMemorySchema,
    handler: (supabase, shopId, params) =>
      searchMemory(supabase, shopId, searchMemorySchema.parse(params)),
  },
  {
    name: "search_knowledge",
    description:
      "Semantic search over the shop's own knowledge base — FAQs, policies, deposit rules, brand voice, hours, services we DON'T offer. Use when the question is about how the shop runs (vs what customers have done). Returns the most relevant entries with their similarity score.",
    schema: searchKnowledgeSchema,
    handler: (supabase, shopId, params) =>
      searchKnowledge(supabase, shopId, searchKnowledgeSchema.parse(params)),
  },
  {
    name: "revenue_in_window",
    description:
      "Total paid revenue over a window. Use for 'how much did we make this month', 'revenue this week', 'how much have we collected'. Only counts invoices customers actually paid — not invoices we've sent and are still pending.",
    schema: revenueSchema,
    handler: (supabase, shopId, params) =>
      revenueInWindow(supabase, shopId, revenueSchema.parse(params)),
  },
  {
    name: "top_heat_leads",
    description:
      "List our hottest active leads ranked by Heat Score (0–100). Use for 'what's hot right now', 'who should I call back first', 'show me the warm leads'. Excludes booked leads — those are already won. Score honestly reflects what we've seen (lead age, status, activity, response history, repeat-customer signal); it's a heuristic, not an ML prediction.",
    schema: topHeatSchema,
    handler: (supabase, shopId, params) =>
      topHeatLeads(supabase, shopId, topHeatSchema.parse(params)),
  },
  {
    name: "check_setup_status",
    description:
      "Inspect which Gradia channels are wired up for this shop (voice, email, SMS, payments, calendar) plus services + knowledge counts. Use whenever the operator asks about setup, what's missing, what's connected, or 'are we live yet.' Returns structured status for each channel with a human-readable reason.",
    schema: checkSetupStatusSchema,
    handler: (supabase, shopId) => checkSetupStatus(supabase, shopId),
  },
  {
    name: "recommend_next_setup",
    description:
      "Pick the highest-leverage next setup step for this shop based on what's missing — opinionated for detail shops (services first so the agents can quote, then voice for the biggest lead capture, then SMS, then payments). Use when the operator asks 'what should we do next', 'where do I start', 'help me set this up'. Returns the next move plus the full priority-ordered missing list.",
    schema: recommendNextSetupSchema,
    handler: (supabase, shopId) => recommendNextSetup(supabase, shopId),
  },
  {
    name: "link_to_setup",
    description:
      "Get the in-app deep link + CTA copy for a specific setup area. Always call this when you're about to tell the operator where to go — paste the returned markdownLink directly in your reply so they get a one-tap navigation. Use after recommend_next_setup or any time the operator asks 'where do I…' for a channel.",
    schema: linkToSetupSchema,
    handler: (_supabase, _shopId, params) =>
      linkToSetup(linkToSetupSchema.parse(params)),
  },
  {
    name: "cold_leads",
    description:
      "List leads that have gone cold — new/quoted leads with no booking, at least N days old (oldest first). Use for 'find cold leads to revive', 'who have we lost touch with', 'who quoted but never booked'. These are the revival candidates for a win-back campaign; pair with preview_outreach to draft the revival.",
    schema: coldLeadsSchema,
    handler: (supabase, shopId, params) =>
      coldLeads(supabase, shopId, coldLeadsSchema.parse(params)),
  },
]

export function findBiTool(name: string): BiToolDefinition | undefined {
  return BI_TOOLS.find((t) => t.name === name)
}
