import { describe, it, expect } from "vitest"

import { deriveWizardStep, needsOnboarding } from "@/lib/onboarding"
import { DEFAULT_WORKING_HOURS } from "@/lib/working-hours"

/**
 * Tier 1 — pure, deterministic. Locks the first-run wizard's resume logic
 * and the dashboard gate (GRADIA_UX_ONBOARDING_SPEC Part 1): new shops go
 * through the wizard; shops from before the flag are NEVER trapped.
 *
 * UX-001: the inbox step keys off connection truth (credential pair), not the
 * display email — a mailbox connected with no display email must not bounce
 * the owner back to step 4 forever (the founder repro shape).
 *
 * B-16: a services-and-hours step is inserted between the menu and the
 * inbox (1 shop, 2 services, 3 hours, 4 inbox, 5 number, 6 receptionist).
 * Hours always has a usable default, so it gates on whether the owner has
 * ever saved the step, not on any particular value.
 */

const wired = {
  aurinko_access_token_enc: "enc:token",
  aurinko_account_id: 4242,
  aurinko_account_email: "shop@gmail.com",
  twilio_phone_number: "+16175550100",
  settings: { calendar: { working_hours: DEFAULT_WORKING_HOURS } },
}

describe("deriveWizardStep — resume at the first incomplete step", () => {
  it("no shop → step 1 (the only required step)", () => {
    expect(deriveWizardStep(null, 0)).toBe(1)
  })

  it("shop but empty menu → step 2", () => {
    expect(deriveWizardStep(wired, 0)).toBe(2)
  })

  it("menu present but hours never saved → step 3", () => {
    expect(deriveWizardStep({ ...wired, settings: {} }, 3)).toBe(3)
    expect(
      deriveWizardStep({ ...wired, settings: { calendar: {} } }, 3)
    ).toBe(3)
  })

  it("hours saved but no inbox → step 4; inbox but no number → step 5", () => {
    expect(
      deriveWizardStep(
        {
          ...wired,
          aurinko_access_token_enc: null,
          aurinko_account_id: null,
          aurinko_account_email: null,
        },
        3
      )
    ).toBe(4)
    expect(
      deriveWizardStep({ ...wired, twilio_phone_number: null }, 3)
    ).toBe(5)
  })

  it("everything wired → step 6 (receptionist + test call)", () => {
    expect(deriveWizardStep(wired, 3)).toBe(6)
  })

  it("UX-001 founder repro: credentials on file, display email null → inbox counts as done", () => {
    const repro = { ...wired, aurinko_account_email: null }
    expect(deriveWizardStep(repro, 3)).toBe(6)
    expect(deriveWizardStep({ ...repro, twilio_phone_number: null }, 3)).toBe(5)
  })

  it("a stale display email without credentials does NOT count as connected", () => {
    expect(
      deriveWizardStep(
        { ...wired, aurinko_access_token_enc: null, aurinko_account_id: null },
        3
      )
    ).toBe(4)
  })

  it("the interim numeric working_hours_per_day (pre-B-16) also counts as saved", () => {
    expect(
      deriveWizardStep(
        {
          ...wired,
          aurinko_access_token_enc: null,
          aurinko_account_id: null,
          aurinko_account_email: null,
          settings: { calendar: { working_hours_per_day: 8 } },
        },
        3
      )
    ).toBe(4)
  })
})

describe("needsOnboarding — the dashboard gate", () => {
  it("gates only shops explicitly marked onboarding_done:false", () => {
    expect(needsOnboarding({ onboarding_done: false })).toBe(true)
  })

  it("finished wizard → no gate", () => {
    expect(needsOnboarding({ onboarding_done: true })).toBe(false)
  })

  it("existing shops (no key / no settings) are never trapped", () => {
    expect(needsOnboarding({})).toBe(false)
    expect(needsOnboarding(null)).toBe(false)
    expect(needsOnboarding(undefined)).toBe(false)
    expect(needsOnboarding({ autonomy: { default: "suggest" } })).toBe(false)
  })
})
