import { describe, it, expect } from "vitest"

import {
  carrierApprovalCopy,
  deriveWizardStep,
  messageApprovalCopy,
  needsOnboarding,
  showsDetailingFields,
} from "@/lib/onboarding"

/**
 * Three-step wizard: Your business → Your number → What would you like help with first?
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

describe("approval status copy", () => {
  it("names carrier states in plain language", () => {
    expect(carrierApprovalCopy("none").label).toBe("Not started")
    expect(carrierApprovalCopy("brand_pending").label).toBe("Waiting for approval")
    expect(carrierApprovalCopy("approved").label).toBe("Approved")
    expect(carrierApprovalCopy("rejected").label).toBe("Needs a fix")
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
