import type { SupabaseClient } from "@supabase/supabase-js"

import type { ChatMessage } from "@/lib/bi-agent"
import { streamOwnerAgent } from "@/lib/owner-agent"
import type { ShopRow } from "@/lib/types/database"

/**
 * Shared harness for the Gradia Agent live evals (smoke + routing/grounding).
 * A table-aware in-memory Supabase double so we drive the REAL loop with a
 * known dataset and capture what gets staged — no live DB.
 */

export const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString()

export const COLD_LEADS = [
  { id: "lead_1", shop_id: "shop_test", customer_id: null, customer_name: "Mike Reyes", phone: "+15551110001", car_info: "2019 Tesla Model 3", vehicle_make: "Tesla", vehicle_model: "Model 3", vehicle_year: 2019, pin_notes: "Wanted ceramic, never booked", status: "quoted", created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: "lead_2", shop_id: "shop_test", customer_id: null, customer_name: "Dana Webb", phone: "+15551110002", car_info: "2021 Audi Q5", vehicle_make: "Audi", vehicle_model: "Q5", vehicle_year: 2021, pin_notes: "Quoted full detail", status: "quoted", created_at: daysAgo(140), updated_at: daysAgo(140) },
  { id: "lead_3", shop_id: "shop_test", customer_id: null, customer_name: "Sam Carter", phone: "+15551110003", car_info: "2018 Ford F-150", vehicle_make: "Ford", vehicle_model: "F-150", vehicle_year: 2018, pin_notes: "Asked about PPF", status: "new", created_at: daysAgo(95), updated_at: daysAgo(95) },
]

export const SHOP = {
  id: "shop_test",
  name: "Pristine Detailing",
  plan: "active",
  tier: "core",
  trial_ends_at: null,
  voice_addon: false,
  settings: {},
  credit_period_start: daysAgo(10),
  twilio_phone_number: "+15559990000",
  aurinko_access_token_enc: null,
} as unknown as ShopRow

export function makeOwnerMock(
  onInsert: (table: string, rows: unknown) => void,
  seed: { customers?: unknown[]; services?: unknown[]; knowledge?: unknown[] } = {}
): SupabaseClient {
  const tables: Record<string, unknown[]> = {
    leads: COLD_LEADS,
    customers: seed.customers ?? [],
    services: seed.services ?? [],
    shop_knowledge: seed.knowledge ?? [],
    interactions: [],
    usage_events: [],
    credit_grants: [],
    pricing_config: [],
    __rpc__: [],
  }
  function chainFor(table: string): unknown {
    const state = { insert: false, single: false, rows: null as unknown }
    const settle = () => {
      if (state.insert) {
        const arr = Array.isArray(state.rows) ? state.rows : [state.rows]
        const withId = arr.map((r, i) => ({ id: `${table}_${i}`, ...(r as object) }))
        return { data: state.single ? withId[0] ?? null : withId, error: null }
      }
      const data = tables[table] ?? []
      return { data: state.single ? data[0] ?? null : data, error: null, count: data.length }
    }
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve(settle()).then(res, rej)
        if (prop === "insert")
          return (rows: unknown) => {
            state.insert = true
            state.rows = rows
            onInsert(table, rows)
            return proxy
          }
        if (prop === "single" || prop === "maybeSingle")
          return () => {
            state.single = true
            return proxy
          }
        return () => proxy
      },
    })
    return proxy
  }
  return {
    from: (table: string) => chainFor(table),
    rpc: () => chainFor("__rpc__"),
  } as unknown as SupabaseClient
}

export type TurnLog = { text: string; tools: string[] }

export async function runOwnerTurn(
  supabase: SupabaseClient,
  history: ChatMessage[]
): Promise<TurnLog> {
  let text = ""
  const tools: string[] = []
  for await (const ev of streamOwnerAgent({
    supabase,
    shop: SHOP,
    ownerId: "owner_test",
    history,
  })) {
    if (ev.type === "text_delta") text += ev.text
    else if (ev.type === "tool_start") tools.push(ev.name)
    else if (ev.type === "error") text += `\n[error] ${ev.message}`
  }
  return { text, tools }
}
