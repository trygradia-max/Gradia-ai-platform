import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}))
vi.mock("@/app/actions/onboarding", () => ({
  completeOnboarding: vi.fn(),
  saveOnboardingProgress: vi.fn(),
}))
vi.mock("@/app/actions/shop", () => ({ saveShop: vi.fn() }))
vi.mock("@/app/actions/working-hours", () => ({ saveWorkingHours: vi.fn() }))

import { OnboardingWizard } from "@/components/gradia/onboarding-wizard"

const shop = {
  id: "shop",
  name: "North Shore",
  location: "Boston",
  phone: null,
  settings: { business_kind: "general" as const, onboarding_step: 1 as const },
  twilio_phone_number: null,
  gradia_number_e164: null,
  voice_addon: false,
  voice_live: false,
}

describe("onboarding wizard presentation", () => {
  it("shows the business step with a clear save button", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingWizard, {
        initialShop: null,
        initialStep: 1,
        a2pState: { status: "none", failureReason: null, business: null },
        voiceOptions: [],
        vapiConfigured: false,
      })
    )
    expect(html).toContain("Your business")
    expect(html).toContain("Save and continue")
    expect(html).toContain("Something else")
    expect(html).toContain("Step 1 of 3")
  })

  it("shows number actions, carrier status, and saved progress on step 2", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingWizard, {
        initialShop: shop as never,
        initialStep: 2,
        a2pState: { status: "brand_pending", failureReason: null, business: null },
        voiceOptions: [],
        vapiConfigured: false,
      })
    )
    expect(html).toContain("Skip number for now")
    expect(html).toContain("Continue to help")
    expect(html).toContain("Waiting for approval")
    expect(html).toContain("Carrier approval")
  })

  it("shows test-call steps and message approval on the help step", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingWizard, {
        initialShop: { ...shop, settings: { business_kind: "general", onboarding_step: 3 } } as never,
        initialStep: 3,
        a2pState: { status: "none", failureReason: null, business: null },
        voiceOptions: [],
        vapiConfigured: false,
      })
    )
    expect(html).toContain("Choose your help")
    expect(html).toContain("Place a test call")
    expect(html).toContain("Waiting for you")
    expect(html).toContain("Finish setup")
    expect(html).toContain("Phone help is optional")
  })
})
