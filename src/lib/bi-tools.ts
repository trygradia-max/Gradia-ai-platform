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

import { searchCustomerMemory } from "@/lib/memory"
import type { InteractionChannel, LeadStatus } from "@/lib/types/database"

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
    return { query: params.query, matches: results }
  } catch (err) {
    return {
      query: params.query,
      matches: [],
      error:
        err instanceof Error ? err.message : "search failed (no embeddings?)",
    }
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
    name: "search_memory",
    description:
      "Semantic search over every customer touchpoint we've recorded. Use for 'who asked about ceramic this week', 'what did Sam say on his last call', 'anything about a Tesla recently'.",
    schema: searchMemorySchema,
    handler: (supabase, shopId, params) =>
      searchMemory(supabase, shopId, searchMemorySchema.parse(params)),
  },
]

export function findBiTool(name: string): BiToolDefinition | undefined {
  return BI_TOOLS.find((t) => t.name === name)
}
