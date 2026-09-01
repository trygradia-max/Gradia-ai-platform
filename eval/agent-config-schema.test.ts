import { describe, expect, it } from "vitest"

import { agentConfigSchema, parseAgentConfig } from "@/lib/agent-config-schema"

/**
 * P0-011 (audit M-2) — the server-side AgentConfig gate. saveCustomAgent /
 * previewCustomAgentPlan used to cast `z.unknown()` straight to AgentConfig;
 * these tests lock the replacement: every currently-valid planner output
 * passes, and malformed filter keys / out-of-range values / smuggled extra
 * fields are rejected.
 */

const base = {
  name: "Quote follow-up after 7 days",
  short_description: "We nudge quoted leads who went quiet.",
  trigger: { kind: "schedule" as const, schedule_summary: "every day at 9am" },
  audience: {
    entity: "leads" as const,
    filters_summary: ["still in quoted status", "older than 7 days"],
  },
  action: {
    kind: "draft_sms" as const,
    intent_summary: "a warm nudge to come back and book if they're still interested",
  },
  prerequisites_needed: ["Twilio number connected"],
  human_in_the_loop_note:
    "Every outbound message still lands as an approval card before it sends.",
}

describe("agentConfigSchema — accepts real planner shapes", () => {
  it("accepts a recipe config (lead_followup_sms + schedule)", () => {
    const res = parseAgentConfig({
      ...base,
      recipe: {
        id: "lead_followup_sms",
        params: { status: "quoted", min_lead_age_days: 7, no_inbound_within_days: 3 },
      },
      schedule: { cadence: "daily", hour_of_day: 14 },
    })
    expect(res.ok).toBe(true)
  })

  it("accepts an event recipe with empty params and no schedule", () => {
    const res = parseAgentConfig({
      ...base,
      trigger: { kind: "event", event_summary: "when an invoice is paid" },
      recipe: { id: "payment_received_thank_you_sms", params: {} },
    })
    expect(res.ok).toBe(true)
  })

  it("accepts a freeform plan with the full whitelisted filter set", () => {
    const res = parseAgentConfig({
      ...base,
      freeform: {
        entity: "customers",
        channel: "sms",
        filters: {
          inactive_days: 90,
          keyword: "ceramic",
          vehicle_make: "Tesla",
          vehicle_model: "Model 3",
          vehicle_year_min: 2018,
          vehicle_year_max: 2026,
          not_visited_in_days: 180,
          recovered_only: true,
        },
        message_intent: "a warm win-back nudge for ceramic customers",
        max_recipients: 50,
        cooldown_days: 30,
      },
      schedule: { cadence: "weekly", hour_of_day: 14, day_of_week: 1 },
    })
    expect(res.ok).toBe(true)
  })

  it("accepts a plan-only config (no recipe, no freeform)", () => {
    expect(parseAgentConfig(base).ok).toBe(true)
  })
})

describe("agentConfigSchema — rejects malformed payloads", () => {
  it("rejects an unknown freeform filter key (the M-2 attack shape)", () => {
    const res = parseAgentConfig({
      ...base,
      freeform: {
        entity: "customers",
        channel: "sms",
        filters: { inactive_days: 90, raw_sql: "1=1; drop table shops" },
        message_intent: "a warm win-back nudge",
        max_recipients: 50,
        cooldown_days: 30,
      },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("filters")
  })

  it("rejects out-of-range values (max_recipients over the hard cap)", () => {
    const res = parseAgentConfig({
      ...base,
      freeform: {
        entity: "customers",
        channel: "sms",
        filters: { inactive_days: 90 },
        message_intent: "a warm win-back nudge",
        max_recipients: 5000,
        cooldown_days: 30,
      },
    })
    expect(res.ok).toBe(false)
  })

  it("rejects smuggled top-level keys", () => {
    const res = parseAgentConfig({ ...base, shop_id: "someone-elses-shop" })
    expect(res.ok).toBe(false)
  })

  it("rejects an unknown recipe id", () => {
    const res = parseAgentConfig({
      ...base,
      recipe: { id: "exfiltrate_customers", params: {} },
    })
    expect(res.ok).toBe(false)
  })

  it("rejects recipe params outside the planner bounds", () => {
    const res = parseAgentConfig({
      ...base,
      recipe: {
        id: "lead_followup_sms",
        params: { status: "quoted", min_lead_age_days: 0, no_inbound_within_days: 3 },
      },
      schedule: { cadence: "daily" },
    })
    expect(res.ok).toBe(false)
  })

  it("rejects a non-object outright", () => {
    expect(parseAgentConfig("not a config").ok).toBe(false)
    expect(parseAgentConfig(null).ok).toBe(false)
  })
})

describe("agentConfigSchema — schema/type parity", () => {
  it("exports a strict object schema (unknown keys are errors, not passengers)", () => {
    const direct = agentConfigSchema.safeParse({ ...base, extra_key: true })
    expect(direct.success).toBe(false)
  })
})
