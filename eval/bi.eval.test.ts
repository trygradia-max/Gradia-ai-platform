import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { runBiAgent } from "@/lib/bi-agent"
import { BI_TOOLS } from "@/lib/bi-tools"
import { LIVE, judge, mockSupabase } from "./_lib"

/**
 * BI agent — three assertions in one self-contained run (no real DB):
 *   Tier 2 (exact):  it states the right number, and
 *   read-only guard: every tool it called is in the read-only BI catalog.
 *   Tier 3 (judge):  a second model scores the answer's tone against a rubric.
 *
 * The mock Supabase returns a known dataset (3 leads), so the only correct
 * answer is "3" — anything else is a regression in tool-routing or summarizing.
 */
describe.skipIf(!LIVE)("BI agent answer quality [live]", () => {
  const READ_ONLY = new Set(BI_TOOLS.map((t) => t.name))

  it("answers a lead-count question: right number, read-only, in-voice", async () => {
    const supabase = mockSupabase({ count: 3, data: [], error: null })

    const { text, toolsUsed } = await runBiAgent({
      supabase: supabase as unknown as SupabaseClient,
      shopId: "shop_test",
      history: [
        { role: "user", content: "How many leads did we get in the last 7 days?" },
      ],
    })

    // read-only: it can only ever reach for tools in the read-only catalog
    for (const t of toolsUsed) {
      expect(READ_ONLY.has(t), `used non-catalog tool: ${t}`).toBe(true)
    }
    expect(toolsUsed, "should route to count_leads").toContain("count_leads")

    // exact: the dataset has 3 leads, so the answer must say 3
    expect(text, "answer should state the count (3)").toMatch(/\b3\b/)

    // judge: tone + no fabrication (open-ended, so scored not string-matched)
    const verdict = await judge({
      output: text,
      rubric: [
        "States the number 3.",
        "Concise — 1 to 3 sentences.",
        // Partner voice, but NOT the strict no-\"I\" rule — PROJECT_BRIEF's own
        // voice example uses \"I handled the backend\", so we judge the
        // defensible intent (insider, not a detached third party) instead.
        'Reads as the shop\'s own partner/co-owner ("we"/"our", or "I" as the back-office half) — not a detached outside service referring to "the shop" or "your business" as an outsider.',
        "Does NOT invent customer names, vehicles, prices, or revenue (none were provided).",
      ].join("\n"),
    })
    expect(verdict.pass, `judge: ${verdict.reason}`).toBe(true)
  })
})
