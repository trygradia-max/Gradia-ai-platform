import { describe, it, expect } from "vitest"

import { describeA2pRegistration } from "@/lib/a2p-state"
import {
  deriveWizardStep,
  messageApprovalCopy,
  needsOnboarding,
  registrationFromA2pState,
  showsDetailingFields,
  textingActionCopy,
} from "@/lib/onboarding"

/**
 * Three-step wizard: Your business → Your number → Choose your help.
 * A saved onboarding_step wins over inferred completeness so a refresh
 * returns to the same place.
 */

const shop = {
  twilio_phone_number: "+16175550100",
  settings: { onboarding_step: 2 as const },
}

describe("deriveWizardStep — saved progress", () => {
  it("no shop → step 1", () => {
    expect(deriveWizardStep(null)).toBe(1)
  })

  it("a saved step is where the owner left off", () => {
    expect(deriveWizardStep(shop)).toBe(2)
    expect(deriveWizardStep({ ...shop, settings: { onboarding_step: 3 } })).toBe(3)
    expect(deriveWizardStep({ ...shop, settings: { onboarding_step: 1 } })).toBe(1)
  })

  it("without a saved step, a missing number resumes at the number", () => {
    expect(
      deriveWizardStep({ twilio_phone_number: null, settings: {} })
    ).toBe(2)
  })

  it("a skipped number moves on to help", () => {
    expect(
      deriveWizardStep({
        twilio_phone_number: null,
        settings: { onboarding_number_skipped: true },
      })
    ).toBe(3)
  })

  it("a saved number without an explicit step opens help", () => {
    expect(
      deriveWizardStep({ twilio_phone_number: "+16175550100", settings: {} })
    ).toBe(3)
  })
})

describe("detailing fields follow the saved business kind", () => {
  it("defaults to detailing when the kind was never saved", () => {
    expect(showsDetailingFields({})).toBe(true)
    expect(showsDetailingFields(null)).toBe(true)
  })

  it("hides vehicle fields only for a general business", () => {
    expect(showsDetailingFields({ business_kind: "general" })).toBe(false)
    expect(showsDetailingFields({ business_kind: "detailing" })).toBe(true)
  })
})

describe("texting next action", () => {
  it("uses the published nextAction and keeps calls out of the texting label", () => {
    expect(textingActionCopy("submit")).toMatchObject({ label: "Not set up", button: "Submit for texting approval" })
    expect(textingActionCopy("resume").button).toBe("Continue texting approval")
    expect(textingActionCopy("fix_and_resubmit").label).toBe("Needs a correction")
    expect(textingActionCopy("resubmit_campaign").button).toBe("Resubmit texting campaign")
    expect(textingActionCopy("wait")).toMatchObject({ label: "Submitted for review", button: "Check texting status" })
    expect(textingActionCopy("none").label).toBe("Ready")
    for (const action of ["submit", "resume", "fix_and_resubmit", "resubmit_campaign", "wait", "none"] as const) {
      expect(textingActionCopy(action).detail).not.toMatch(/call/i)
    }
  })

  it("prefers a stored registration over a status-only fallback", () => {
    const registration = describeA2pRegistration({
      status: "rejected",
      failed_step: "campaign",
      retryable: false,
      failure_reason: "Campaign refused",
      attempts: 2,
    })
    expect(registrationFromA2pState({
      status: "rejected",
      failureReason: "Campaign refused",
      registration,
    }).nextAction).toBe("resubmit_campaign")
    expect(registrationFromA2pState({ status: "brand_pending", failureReason: null }).nextAction).toBe("wait")
  })

  it("says texts wait for approval unless the owner turned that off", () => {
    expect(messageApprovalCopy("suggest").label).toBe("Waiting for you")
    expect(messageApprovalCopy("autonomous").detail).toMatch(/still wait/)
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
