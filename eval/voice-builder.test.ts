import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { GRADIA_VOICE } from "@/lib/persona"
import {
  composeVoiceAssistant,
  voiceBudgetState,
  voiceLaunchGate,
  VOICE_TOOL_DEFINITIONS,
} from "@/lib/voice-provider"
import type { ServiceRow, ShopKnowledgeRow } from "@/lib/types/database"

/**
 * Tier 1 — pure, deterministic, no API. Locks the Phase 2 voice builder's
 * invariants: form facts land in the composed prompt (single persona
 * source), the launch gate's three prerequisites, the 80/100% minute
 * budget thresholds, and the declared tool surface.
 */

const shop = { name: "Pristine Detailing", location: "Boston", phone: "+16175550100" }

const services = [
  {
    id: "s1",
    shop_id: "shop-1",
    name: "Ceramic coating",
    description: null,
    price_cents: 80_000,
    duration_minutes: 240,
  },
] as unknown as ServiceRow[]

const knowledge = [
  { id: "k1", shop_id: "shop-1", source_name: "Deposits", content: "We take a $50 deposit on coatings." },
] as unknown as ShopKnowledgeRow[]

describe("composeVoiceAssistant — form facts land in the prompt", () => {
  it("weaves hours, escalation, and the persona's we/us rule into one composition", () => {
    const composed = composeVoiceAssistant({
      shop,
      config: {
        greeting: "You've reached Pristine — talk to us.",
        hours_text: "Mon–Sat 8am–6pm",
        after_hours: "take_message",
        escalation_phone: "+16175550199",
        voice: "warm-male",
      },
      services,
      knowledge,
    })
    expect(composed.firstMessage).toBe("You've reached Pristine — talk to us.")
    expect(composed.systemPrompt).toContain("Mon–Sat 8am–6pm")
    expect(composed.systemPrompt).toContain("+16175550199")
    expect(composed.systemPrompt).toContain("Ceramic coating")
    expect(composed.systemPrompt).toContain("$50 deposit")
    // Persona is the single tone source — composed in, never duplicated.
    expect(composed.systemPrompt).toContain(GRADIA_VOICE)
    expect(composed.voice).toBe("warm-male")
  })

  it("booking_mode flips the rule: calendar link vs staged propose_booking", () => {
    const linkMode = composeVoiceAssistant({
      shop,
      config: { booking_mode: "calendar_link", calendar_link: "https://cal.com/pristine" },
      services,
      knowledge,
    })
    expect(linkMode.systemPrompt).toContain("https://cal.com/pristine")
    expect(linkMode.systemPrompt).not.toContain("propose_booking tool")

    const stagedMode = composeVoiceAssistant({
      shop,
      config: { booking_mode: "propose_booking" },
      services,
      knowledge,
    })
    expect(stagedMode.systemPrompt).toContain("propose_booking")
    // HITL stays in the prompt regardless of mode.
    expect(stagedMode.systemPrompt).toContain("Never confirm a booking unilaterally")
  })
})

describe("voiceLaunchGate — number, assistant, test call, no shortcuts", () => {
  it("reports exactly what's missing", () => {
    expect(
      voiceLaunchGate({
        vapi_assistant_id: null,
        vapi_phone_number_id: null,
        voice_test_called_at: null,
      })
    ).toEqual({ ready: false, missing: ["number", "assistant", "test_call"] })

    expect(
      voiceLaunchGate({
        vapi_assistant_id: "asst_1",
        vapi_phone_number_id: "pn_1",
        voice_test_called_at: null,
      })
    ).toEqual({ ready: false, missing: ["test_call"] })
  })

  it("all three present → ready", () => {
    expect(
      voiceLaunchGate({
        vapi_assistant_id: "asst_1",
        vapi_phone_number_id: "pn_1",
        voice_test_called_at: "2026-06-11T10:00:00Z",
      }).ready
    ).toBe(true)
  })
})

describe("minute allowance — 60 included + packs; warn 80%, fail closed 100%", () => {
  /** usage_events minutes + credit_grants minute packs, table-aware. */
  function ledgerWith(minutes: number, packMinutes = 0): SupabaseClient {
    return {
      from: (table: string) => ({
        select: () => ({
          eq: () =>
            table === "credit_grants"
              ? {
                  gte: () =>
                    Promise.resolve({
                      data: packMinutes ? [{ minutes: packMinutes }] : [],
                      error: null,
                    }),
                }
              : {
                  eq: () => ({
                    gte: () =>
                      Promise.resolve({
                        data: [{ quantity: minutes }],
                        error: null,
                      }),
                  }),
                },
        }),
      }),
    } as unknown as SupabaseClient
  }

  const budgetShop = (
    voice_minutes_budget: number | null,
    voice_addon = true
  ) => ({
    id: "shop-1",
    voice_addon,
    voice_minutes_budget,
  })

  it("the add-on includes 60 minutes; under 80%: quiet", async () => {
    const state = await voiceBudgetState(ledgerWith(40), budgetShop(null))
    expect(state).toMatchObject({
      budget: 60,
      warn: false,
      over: false,
      usedMinutes: 40,
    })
  })

  it("exactly 80% of the allowance: warn, not over", async () => {
    const state = await voiceBudgetState(ledgerWith(48), budgetShop(null))
    expect(state).toMatchObject({ warn: true, over: false })
  })

  it("at/over 100%: fail closed (take-a-message fallback on the NEXT call)", async () => {
    expect(await voiceBudgetState(ledgerWith(60), budgetShop(null))).toMatchObject({ over: true })
    expect(await voiceBudgetState(ledgerWith(75), budgetShop(null))).toMatchObject({ over: true })
  })

  it("a $10 minute pack extends the allowance by 40", async () => {
    const state = await voiceBudgetState(ledgerWith(70, 40), budgetShop(null))
    expect(state).toMatchObject({ budget: 100, over: false })
  })

  it("an owner cap below the allowance wins", async () => {
    const state = await voiceBudgetState(ledgerWith(30), budgetShop(30))
    expect(state).toMatchObject({ budget: 30, over: true })
  })

  it("no voice add-on: zero allowance — voice is volume-gated off", async () => {
    const state = await voiceBudgetState(ledgerWith(0), budgetShop(null, false))
    expect(state).toMatchObject({ budget: 0, over: true })
  })
})

describe("declared tool surface", () => {
  it("ships exactly the seven receptionist tools the webhook dispatches", () => {
    const names = VOICE_TOOL_DEFINITIONS.map((t) => t.function.name).sort()
    expect(names).toEqual([
      "cancel_appointment",
      "capture_lead",
      "lookup_customer_history",
      "lookup_shop_policy",
      "propose_booking",
      "quote_service",
      "reschedule_appointment",
    ])
  })

  it("booking tool tells the model it's staged, not executed (HITL)", () => {
    const booking = VOICE_TOOL_DEFINITIONS.find(
      (t) => t.function.name === "propose_booking"
    )
    expect(booking?.function.description).toContain("human approval")
  })
})
