import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import type { ChatMessage } from "@/lib/bi-agent"
import { streamOwnerAgent } from "@/lib/owner-agent"
import type { ShopRow } from "@/lib/types/database"

import { LIVE } from "./_lib"

/**
 * Gradia Agent — live smoke test of the full read+act loop (Tier 2/3).
 *
 * Drives the REAL conversation loop (Sonnet) + REAL per-recipient drafting
 * (Haiku) against a seeded in-memory CRM, and watches a cold-lead revival run
 * end to end: diagnose (cold_leads) → preview (preview_outreach drafts samples)
 * → confirm → stage (stage_outreach queues pending_actions). No live DB — a
 * table-aware mock returns the dataset and captures what gets staged.
 *
 * Run: `npm run eval` (sets EVAL_LIVE=1; keys load from .env.local).
 */

// --- seeded CRM: three cold leads, quoted but never booked, 120 days old -----
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

const COLD_LEADS = [
  { id: "lead_1", shop_id: "shop_test", customer_id: null, customer_name: "Mike Reyes", phone: "+15551110001", car_info: "2019 Tesla Model 3", vehicle_make: "Tesla", vehicle_model: "Model 3", vehicle_year: 2019, pin_notes: "Wanted ceramic, never booked", status: "quoted", created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: "lead_2", shop_id: "shop_test", customer_id: null, customer_name: "Dana Webb", phone: "+15551110002", car_info: "2021 Audi Q5", vehicle_make: "Audi", vehicle_model: "Q5", vehicle_year: 2021, pin_notes: "Quoted full detail", status: "quoted", created_at: daysAgo(140), updated_at: daysAgo(140) },
  { id: "lead_3", shop_id: "shop_test", customer_id: null, customer_name: "Sam Carter", phone: "+15551110003", car_info: "2018 Ford F-150", vehicle_make: "Ford", vehicle_model: "F-150", vehicle_year: 2018, pin_notes: "Asked about PPF", status: "new", created_at: daysAgo(95), updated_at: daysAgo(95) },
]

const SHOP = {
  id: "shop_test",
  name: "Pristine Detailing",
  plan: "active",
  voice_addon: false,
  settings: {},
  credit_period_start: daysAgo(10),
  twilio_phone_number: "+15559990000",
  aurinko_access_token_enc: null,
} as unknown as ShopRow

/** Table-aware mock: per-table canned rows + captured inserts. */
function makeMock(
  onInsert: (table: string, rows: unknown) => void,
  seed: { customers?: unknown[]; services?: unknown[] } = {}
) {
  const tables: Record<string, unknown[]> = {
    leads: COLD_LEADS,
    customers: seed.customers ?? [],
    services: seed.services ?? [],
    interactions: [],
    usage_events: [],
    credit_grants: [],
    pricing_config: [],
    knowledge: [],
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

type TurnLog = { text: string; tools: string[] }

async function runTurn(
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

describe.skipIf(!LIVE)("Gradia Agent — cold-lead revival [live]", () => {
  it("diagnoses cold leads, previews a revival, and stages on confirmation", async () => {
    const staged: { table: string; rows: unknown }[] = []
    const supabase = makeMock((table, rows) => {
      if (table === "pending_actions") staged.push({ table, rows })
    })

    const history: ChatMessage[] = [
      {
        role: "user",
        content:
          "Come up with a cold-lead revival over SMS — find the leads who quoted but never booked, and show me a preview with a couple sample texts.",
      },
    ]

    const allTools: string[] = []
    let sawStage = false

    for (let turn = 0; turn < 3 && !sawStage; turn++) {
      const { text, tools } = await runTurn(supabase, history)
      allTools.push(...tools)
      // Surface the run so a human can read the conversation.
      console.log(`\n=== TURN ${turn + 1} ===`)
      console.log("tools:", tools.join(", ") || "(none)")
      console.log("gradia:", text.trim().slice(0, 800))
      history.push({ role: "assistant", content: text })
      if (tools.includes("stage_outreach")) sawStage = true
      else
        history.push({
          role: "user",
          content: "Yes — go ahead and stage them for my approval.",
        })
    }

    console.log("\n=== STAGED pending_actions ===", staged.length)
    for (const s of staged) console.log(JSON.stringify(s.rows))

    // It investigated and previewed before proposing...
    expect(allTools, "should preview before staging").toContain("preview_outreach")
    // ...and staged real drafts on confirmation.
    expect(allTools, "should stage on confirmation").toContain("stage_outreach")
    expect(staged.length, "should queue at least one draft in Approvals").toBeGreaterThan(0)
  }, 240_000)

  it("proposes a booking that stages an always-HITL book_appointment", async () => {
    const staged: { rows: unknown }[] = []
    const supabase = makeMock(
      (table, rows) => {
        if (table === "pending_actions") staged.push({ rows })
      },
      {
        customers: [
          { id: "c1", name: "Sam Carter", phone: "+15551110003", email: null, vehicle_make: "Ford", vehicle_model: "F-150", vehicle_year: 2018, last_visit_at: null },
        ],
        services: [{ name: "Full detail", price_cents: 25_000, duration_minutes: 120 }],
      }
    )

    const history: ChatMessage[] = [
      { role: "user", content: "Book Sam Carter for a full detail this Saturday at 3pm." },
    ]
    const allTools: string[] = []
    let done = false
    for (let turn = 0; turn < 3 && !done; turn++) {
      const { text, tools } = await runTurn(supabase, history)
      allTools.push(...tools)
      console.log(`\n=== BOOKING TURN ${turn + 1} ===`)
      console.log("tools:", tools.join(", ") || "(none)")
      console.log("gradia:", text.trim().slice(0, 600))
      history.push({ role: "assistant", content: text })
      if (tools.includes("propose_booking")) done = true
      else history.push({ role: "user", content: "Yes, go ahead and stage it." })
    }

    const types = staged.map(
      (s) => (s.rows as { action_type?: string }).action_type
    )
    console.log("\n=== STAGED ===", JSON.stringify(staged.map((s) => s.rows)))
    expect(allTools, "should call propose_booking").toContain("propose_booking")
    expect(types, "should stage a book_appointment (always HITL)").toContain("book_appointment")
  }, 240_000)
})
