import { describe, it, expect } from "vitest"

import type { ChatMessage } from "@/lib/bi-agent"

import { LIVE } from "./_lib"
import { makeOwnerMock, runOwnerTurn } from "./_owner"

/**
 * Gradia Agent — live smoke test of the full read+act loop (Tier 2/3).
 *
 * Drives the REAL conversation loop (Sonnet) + REAL drafting (Haiku) against a
 * seeded in-memory CRM, and watches two end-to-end flows: a cold-lead revival
 * (diagnose → preview → confirm → stage) and a single booking. No live DB — a
 * table-aware mock returns the dataset and captures what gets staged.
 *
 * Run: `npm run eval` (sets EVAL_LIVE=1; keys load from .env.local).
 */

describe.skipIf(!LIVE)("Gradia Agent — cold-lead revival [live]", () => {
  it("diagnoses cold leads, previews a revival, and stages on confirmation", async () => {
    const staged: { rows: unknown }[] = []
    const supabase = makeOwnerMock((table, rows) => {
      if (table === "pending_actions") staged.push({ rows })
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
      const { text, tools } = await runOwnerTurn(supabase, history)
      allTools.push(...tools)
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

    console.log("\n=== STAGED ===", staged.length)
    expect(allTools, "should preview before staging").toContain("preview_outreach")
    expect(allTools, "should stage on confirmation").toContain("stage_outreach")
    expect(staged.length, "should queue at least one draft").toBeGreaterThan(0)
  }, 240_000)

  it("proposes a booking that stages an always-HITL book_appointment", async () => {
    const staged: { rows: unknown }[] = []
    const supabase = makeOwnerMock(
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
      const { text, tools } = await runOwnerTurn(supabase, history)
      allTools.push(...tools)
      console.log(`\n=== BOOKING TURN ${turn + 1} ===`, tools.join(", "))
      console.log("gradia:", text.trim().slice(0, 500))
      history.push({ role: "assistant", content: text })
      if (tools.includes("propose_booking")) done = true
      else history.push({ role: "user", content: "Yes, go ahead and stage it." })
    }

    const types = staged.map((s) => (s.rows as { action_type?: string }).action_type)
    expect(allTools, "should call propose_booking").toContain("propose_booking")
    expect(types, "should stage a book_appointment (always HITL)").toContain("book_appointment")
  }, 240_000)
})
