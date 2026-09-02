import { describe, it, expect } from "vitest"

import { deriveWizardStep, needsOnboarding } from "@/lib/onboarding"

/**
 * Tier 1 — pure, deterministic. Locks the first-run wizard's resume logic
 * and the dashboard gate (GRADIA_UX_ONBOARDING_SPEC Part 1): new shops go
 * through the wizard; shops from before the flag are NEVER trapped.
 *
 * UX-001: the inbox step keys off connection truth (credential pair), not the
 * display email — a mailbox connected with no display email must not bounce
 * the owner back to step 3 forever (the founder repro shape).
 */

const wired = {
  aurinko_access_token_enc: "enc:token",
  aurinko_account_id: 4242,
  aurinko_account_email: "shop@gmail.com",
  twilio_phone_number: "+16175550100",
}

describe("deriveWizardStep — resume at the first incomplete step", () => {
  it("no shop → step 1 (the only required step)", () => {
    expect(deriveWizardStep(null, 0)).toBe(1)
  })

  it("shop but empty menu → step 2", () => {
    expect(deriveWizardStep(wired, 0)).toBe(2)
  })

  it("menu but no inbox → step 3; inbox but no number → step 4", () => {
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
    ).toBe(3)
    expect(
      deriveWizardStep({ ...wired, twilio_phone_number: null }, 3)
    ).toBe(4)
  })

  it("everything wired → step 5 (receptionist + test call)", () => {
    expect(deriveWizardStep(wired, 3)).toBe(5)
  })

  it("UX-001 founder repro: credentials on file, display email null → inbox counts as done", () => {
    const repro = { ...wired, aurinko_account_email: null }
    expect(deriveWizardStep(repro, 3)).toBe(5)
    expect(deriveWizardStep({ ...repro, twilio_phone_number: null }, 3)).toBe(4)
  })

  it("a stale display email without credentials does NOT count as connected", () => {
    expect(
      deriveWizardStep(
        { ...wired, aurinko_access_token_enc: null, aurinko_account_id: null },
        3
      )
    ).toBe(3)
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
