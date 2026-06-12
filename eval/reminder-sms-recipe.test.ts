import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { looksOptedOut } from "@/lib/agent-audience"
import { RECIPE_HANDLERS } from "@/lib/agent-runtime"
import type { CustomAgentRow, ShopRow } from "@/lib/types/database"

/**
 * Tier 1 — pure, deterministic, no API. Gates the appointment_reminder_sms
 * recipe (principle #6: no new recipe ships without harness coverage).
 * Draft quality is covered live by the drafter evals; these lock the
 * guardrails: registry wiring, prerequisites, and STOP compliance.
 */

describe("recipe registry", () => {
  it("appointment_reminder_sms is wired beside its email twin", () => {
    expect(Object.keys(RECIPE_HANDLERS)).toContain("appointment_reminder_sms")
    expect(Object.keys(RECIPE_HANDLERS)).toContain("appointment_reminder_email")
  })
})

describe("prerequisites fail soft — no queries, no drafts", () => {
  const agent = {
    id: "agent-1",
    name: "Day-before texts",
    owner_id: "owner-1",
    shop_id: "shop-1",
    config: {
      recipe: {
        id: "appointment_reminder_sms",
        params: { hours_before: 24, window_hours: 1 },
      },
    },
  } as unknown as CustomAgentRow

  const deadSupabase = {
    from: () => {
      throw new Error("must not query before prerequisites pass")
    },
  } as unknown as SupabaseClient

  it("refuses without an SMS number connected", async () => {
    const shop = { id: "shop-1", name: "Pristine", twilio_phone_number: null } as ShopRow
    const outcome = await RECIPE_HANDLERS.appointment_reminder_sms(
      deadSupabase,
      shop,
      agent
    )
    expect(outcome.fired).toBe(false)
    expect(outcome.reason).toContain("SMS number")
  })

  it("refuses a mismatched recipe id", async () => {
    const shop = {
      id: "shop-1",
      name: "Pristine",
      twilio_phone_number: "+16175550100",
    } as ShopRow
    const wrongAgent = {
      ...agent,
      config: { recipe: { id: "stale_customer_sms", params: {} } },
    } as unknown as CustomAgentRow
    const outcome = await RECIPE_HANDLERS.appointment_reminder_sms(
      deadSupabase,
      shop,
      wrongAgent
    )
    expect(outcome.fired).toBe(false)
  })
})

describe("STOP compliance — the opt-out net the recipe relies on", () => {
  it("catches the carrier keywords in real phrasings", () => {
    for (const msg of [
      "STOP",
      "stop",
      "Please remove me from this list",
      "unsubscribe",
      "CANCEL",
      "opt out please",
    ]) {
      expect(looksOptedOut(msg), `"${msg}" should opt out`).toBe(true)
    }
  })

  it("doesn't false-positive normal customer talk", () => {
    for (const msg of [
      "can we do Saturday instead?",
      "how much for a full detail?",
      "running late, be there in 10",
    ]) {
      expect(looksOptedOut(msg), `"${msg}" should NOT opt out`).toBe(false)
    }
  })
})
