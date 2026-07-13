import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"

import {
  AUTOMATION_CATALOG,
  AUTOMATION_KEYS,
  catalogEntry,
  renderTemplate,
} from "@/lib/automations"
import {
  looksLikeMissedCall,
  QUOTE_FOLLOWUP_DAYS,
} from "@/lib/automation-sweeps"
import {
  AUTOPILOT_BARRED_AUTOMATIONS,
  isAutomationAutopilotAllowed,
} from "@/lib/autonomy"

/**
 * C5 — automation catalog locks: the 8 spec entries, the zero-behavior-
 * change defaults for the pre-existing #5/#6, the money/calendar autopilot
 * floor, and source-level proof that the confirm/reminder crons kept their
 * staging machinery while consulting the catalog.
 */

describe("catalog shape (spec §C5)", () => {
  it("ships exactly the eight entries, in spec order", () => {
    expect(AUTOMATION_KEYS).toEqual([
      "new_lead_instant",
      "missed_call_textback",
      "quote_followup",
      "lead_revival",
      "appt_confirmation",
      "appt_reminder",
      "job_completed",
      "review_request",
    ])
  })

  it("spec default modes hold", () => {
    expect(catalogEntry("new_lead_instant").defaultMode).toBe("autopilot")
    expect(catalogEntry("missed_call_textback").defaultMode).toBe("autopilot")
    expect(catalogEntry("quote_followup").defaultMode).toBe("approval")
    expect(catalogEntry("lead_revival").defaultMode).toBe("approval")
    expect(catalogEntry("job_completed").defaultMode).toBe("autopilot")
    expect(catalogEntry("review_request").defaultMode).toBe("approval")
  })

  it("new automations are opt-in: everything defaults OFF except #5/#6", () => {
    for (const entry of AUTOMATION_CATALOG) {
      const shouldBeOn = entry.key === "appt_confirmation" || entry.key === "appt_reminder"
      expect(entry.defaultEnabled, entry.key).toBe(shouldBeOn)
    }
  })

  it("ZERO BEHAVIOR CHANGE for #5/#6: enabled + approval + built-in copy", () => {
    // These two ran before the catalog existed — staged as approvals with
    // their own copy. The catalog defaults must reproduce that exactly.
    // (The spec table suggests autopilot defaults; the zero-behavior-change
    // rail wins — owners opt in to autopilot themselves.)
    for (const key of ["appt_confirmation", "appt_reminder"] as const) {
      const entry = catalogEntry(key)
      expect(entry.defaultEnabled).toBe(true)
      expect(entry.defaultMode).toBe("approval")
      expect(entry.defaultTemplate).toBe("") // empty = keep the built-in copy
    }
  })
})

describe("money/calendar autopilot floor (hard floor, C5)", () => {
  it("the catalog flags and the autonomy barred-set agree, both ways", () => {
    for (const entry of AUTOMATION_CATALOG) {
      expect(
        AUTOPILOT_BARRED_AUTOMATIONS.has(entry.key),
        `${entry.key} flag/set mismatch`
      ).toBe(entry.touchesMoneyOrCalendar)
    }
    for (const barred of AUTOPILOT_BARRED_AUTOMATIONS) {
      const entry = AUTOMATION_CATALOG.find((e) => e.key === barred)
      expect(entry?.touchesMoneyOrCalendar, `${barred} barred but unflagged`).toBe(true)
    }
  })

  it("a barred key can never be autopilot; launch keys are not barred", () => {
    expect(isAutomationAutopilotAllowed("some_future_money_automation")).toBe(true)
    // (nothing barred at launch — the floor is the mechanism, locked here)
    for (const key of AUTOMATION_KEYS) {
      expect(isAutomationAutopilotAllowed(key)).toBe(true)
    }
    // The write path must reject autopilot for barred entries — source lock.
    const actions = readFileSync(
      new URL("../src/app/actions/automations.ts", import.meta.url),
      "utf8"
    )
    expect(actions).toContain("isAutomationAutopilotAllowed")
    // And the runtime degrades stale rows on read.
    const lib = readFileSync(new URL("../src/lib/automations.ts", import.meta.url), "utf8")
    expect(lib).toContain('isAutomationAutopilotAllowed(key) ? row.mode : "approval"')
  })
})

describe("renderTemplate", () => {
  it("fills tokens from code and collapses unknowns", () => {
    expect(
      renderTemplate("Hi {customer_name}, it's {shop_name} — {unknown_token} welcome!", {
        customer_name: "Ada",
        shop_name: "Shine Co",
      })
    ).toBe("Hi Ada, it's Shine Co — welcome!")
  })
})

describe("sweep heuristics", () => {
  it("quote follow-up touches at 2, 5, and 12 days", () => {
    expect([...QUOTE_FOLLOWUP_DAYS]).toEqual([2, 5, 12])
  })

  it("missed-call detector: reason keywords or a sub-10s call", () => {
    expect(looksLikeMissedCall({ ended_reason: "customer-did-not-answer", duration_seconds: 120 })).toBe(true)
    expect(looksLikeMissedCall({ ended_reason: "twilio-failed", duration_seconds: null })).toBe(true)
    expect(looksLikeMissedCall({ ended_reason: "customer-ended-call", duration_seconds: 4 })).toBe(true)
    expect(looksLikeMissedCall({ ended_reason: "customer-ended-call", duration_seconds: 95 })).toBe(false)
  })
})

describe("#5/#6 refactor keeps the existing machinery (source locks)", () => {
  it("the reminder cron still stages send_sms approvals and stamps idempotency", () => {
    const src = readFileSync(
      new URL("../src/app/api/cron/reminders/route.ts", import.meta.url),
      "utf8"
    )
    expect(src).toContain('action_type: "send_sms"')
    expect(src).toContain("reminder_pending_action_id")
    expect(src).toContain('catalogGateFor(supabase, appt.shop.id, "appt_reminder")')
    expect(src).toContain("draftAppointmentReminderSms") // built-in copy kept
  })

  it("the confirm cron still stages send_sms approvals and stamps idempotency", () => {
    const src = readFileSync(
      new URL("../src/app/api/cron/no-show-ladder/route.ts", import.meta.url),
      "utf8"
    )
    expect(src).toContain('action_type: "send_sms"')
    expect(src).toContain("confirm_pending_action_id")
    expect(src).toContain('catalogGateFor(supabase, appt.shop.id, "appt_confirmation")')
    expect(src).toContain("buildConfirmSms") // Reply-YES contract kept
  })

  it("the sweeps and runner never call a raw send — only pending_actions + executeApproval", () => {
    for (const file of ["../src/lib/automations.ts", "../src/lib/automation-sweeps.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8")
      expect(src, `${file} must not import a raw sender`).not.toContain("sendOutboundSms")
      expect(src, `${file} must not import the email sender`).not.toContain("sendEmailMessage")
    }
  })
})
