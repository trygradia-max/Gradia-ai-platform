import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}))
vi.mock("@/app/actions/a2p", () => ({
  refreshA2pStatus: vi.fn(),
  resendA2pOtp: vi.fn(),
  submitA2pRegistration: vi.fn(),
}))
vi.mock("@/app/actions/byo-sms-attestation", () => ({
  attestByoSmsRegistration: vi.fn(),
  revokeByoSmsRegistration: vi.fn(),
}))

import { A2pWizard } from "@/components/gradia/a2p-wizard"
import { ByoSmsAttestationCard } from "@/components/gradia/byo-sms-attestation-card"
import { ChannelStatusList } from "@/components/gradia/channel-status-list"
import { OnboardingWizard } from "@/components/gradia/onboarding-wizard"
import {
  callsReadiness,
  emailReadiness,
  metaReadiness,
  textingReadiness,
  type ReadinessShop,
} from "@/lib/channel-readiness"
import type { ByoSmsAttestationState } from "@/lib/byo-sms-attestation"
import { describeA2pRegistration } from "@/lib/a2p-state"

const baseShop: ReadinessShop = {
  twilio_phone_number: "+15555550100",
  gradia_number_e164: "+15555550100",
  a2p_status: "pending",
  a2p_verified_at: null,
  byo_sms_verified: false,
  twilio_account_sid_enc: null,
  twilio_auth_token_enc: null,
  vapi_assistant_id: null,
  vapi_phone_number_id: null,
  voice_test_called_at: null,
  voice_addon: false,
  aurinko_access_token_enc: null,
  aurinko_account_id: null,
  aurinko_subscription_id: null,
}

function channels(shop: ReadinessShop) {
  return {
    calls: callsReadiness(shop, true),
    texting: textingReadiness(shop, true),
    email: emailReadiness(shop, true),
    meta: metaReadiness(0, true),
  }
}

const attestation = (state: ByoSmsAttestationState["state"]): ByoSmsAttestationState => ({
  state,
  phone_e164: "+15555550199",
  current_statement_version: "2026-10-16",
  last_event: null,
})

describe("calls and texting stay independent", () => {
  it("shows each channel's own status on the help step", () => {
    const html = renderToStaticMarkup(
      createElement(OnboardingWizard, {
        initialShop: {
          id: "shop",
          settings: { onboarding_step: 3 },
          twilio_phone_number: "+15555550100",
          gradia_number_e164: "+15555550100",
          voice_addon: false,
        } as never,
        initialStep: 3,
        a2pState: { status: "brand_pending", failureReason: null, business: null },
        voiceOptions: [],
        vapiConfigured: false,
        readiness: { ok: true, channels: channels(baseShop) },
      })
    )
    expect(html).toContain('data-channel="calls"')
    expect(html).toContain('data-channel="texting"')
    expect(html).toContain("Not set up")
    expect(html).toContain("Submitted for review")
    const calls = html.indexOf('data-channel="calls"')
    const texting = html.indexOf('data-channel="texting"')
    expect(calls).toBeGreaterThan(-1)
    expect(texting).toBeGreaterThan(calls)
    expect(html.slice(calls, texting)).toContain("Not set up")
    expect(html.slice(texting, html.indexOf('data-channel="email"'))).toContain("Submitted for review")
  })
})

describe("texting registration states", () => {
  it("shows a correction and a resubmit button after rejection", () => {
    const registration = describeA2pRegistration({
      status: "rejected",
      failed_step: "brand",
      retryable: false,
      failure_reason: "Legal name did not match",
      attempts: 1,
    })
    const html = renderToStaticMarkup(
      createElement(A2pWizard, {
        initial: { status: "rejected", failureReason: "Legal name did not match", business: null, registration },
      })
    )
    expect(html).toContain("Needs a correction")
    expect(html).toContain("Fix details and resubmit")
    expect(html).toContain("Legal name did not match")
    expect(html).not.toContain("Calls work")
  })

  it("shows a campaign retry without asking for the business again", () => {
    const registration = describeA2pRegistration({
      status: "rejected",
      failed_step: "campaign",
      retryable: false,
      failure_reason: null,
      attempts: 1,
    })
    const html = renderToStaticMarkup(
      createElement(A2pWizard, {
        initial: { status: "rejected", failureReason: null, business: null, registration },
      })
    )
    expect(html).toContain("Resubmit texting campaign")
    expect(html).toContain("Needs a correction")
  })

  it("keeps a stopped submission on the same details", () => {
    const registration = describeA2pRegistration({
      status: "draft",
      failed_step: "brand",
      retryable: true,
      failure_reason: "Temporary problem",
      attempts: 1,
    })
    const html = renderToStaticMarkup(
      createElement(A2pWizard, {
        initial: {
          status: "draft",
          failureReason: "Temporary problem",
          business: {
            has_ein: true,
            legal_name: "North Shore LLC",
            ein: "12-3456789",
            business_type: "Limited Liability Corporation",
            website_url: "",
            address: { street: "1 Main", city: "Boston", region: "MA", postal_code: "02118" },
            contact: { first_name: "Ada", last_name: "Owner", email: "ada@example.com", phone: "+15555550100", job_position: "Owner" },
          },
          registration,
        },
      })
    )
    expect(html).toContain("Continue texting approval")
    expect(html).toContain("Needs your details")
    expect(html).toContain("North Shore LLC")
  })
})

describe("owner-attested own number", () => {
  it("labels a confirmed number Ready to test", () => {
    const html = renderToStaticMarkup(
      createElement(ByoSmsAttestationCard, { shopId: "shop", initial: { ok: true, attestation: attestation("confirmed") } })
    )
    expect(html).toContain("Ready to test")
    expect(html).not.toContain(">Ready<")
    expect(html).toContain("Withdraw confirmation")
    expect(html).toContain("min-h-11")
  })

  it("keeps the confirm control available until the owner attests", () => {
    const html = renderToStaticMarkup(
      createElement(ByoSmsAttestationCard, { shopId: "shop", initial: { ok: true, attestation: attestation("unconfirmed") } })
    )
    expect(html).toContain("Needs your details")
    expect(html).toContain('id="byo-sms-confirm"')
    expect(html).toContain('for="byo-sms-confirm"')
    expect(html).toContain("Confirm texting registration")
    expect(html).toContain("disabled")
  })
})

describe("channel list keyboard and width", () => {
  it("uses a full-width list with a name on every channel", () => {
    const html = renderToStaticMarkup(createElement(ChannelStatusList, { channels: channels(baseShop) }))
    expect(html).toContain('aria-label="Channel status"')
    expect(html).toContain("Calls")
    expect(html).toContain("Texting")
    expect(html).toContain("Email")
    expect(html).toContain("Facebook lead forms")
    expect(html).toContain("w-full") // may not be on the list
  })
})
