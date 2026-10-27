/**
 * First-run wizard — three steps, with an explicit saved place.
 * Your business → Your number → What would you like help with first?
 */

import { describeA2pRegistration, type A2pNextAction, type A2pRegistrationState } from "@/lib/a2p-state"
import type { A2pRegistrationStatus } from "@/lib/types/database"
import type { ShopRow } from "@/lib/types/database"
import type { AutonomyMode } from "@/lib/autonomy"

export type WizardStep = 1 | 2 | 3
export type BusinessKind = "detailing" | "general"

type WizardShopFields = Partial<Pick<ShopRow, "settings" | "twilio_phone_number">>

export function readBusinessKind(
  settings: Record<string, unknown> | null | undefined
): BusinessKind {
  return settings?.business_kind === "general" ? "general" : "detailing"
}

/** Vehicle size and condition pricing exist on the service row as optional
 *  maps. They show only when the saved business kind is detailing. */
export function showsDetailingFields(
  settings: Record<string, unknown> | null | undefined
): boolean {
  return readBusinessKind(settings) === "detailing"
}

export function readSavedWizardStep(
  settings: Record<string, unknown> | null | undefined
): WizardStep | null {
  const step = settings?.onboarding_step
  return step === 1 || step === 2 || step === 3 ? step : null
}

/**
 * Resume at the saved step when one exists. Otherwise start at the
 * number when it is still missing, then the help step.
 */
export function deriveWizardStep(shop: WizardShopFields | null): WizardStep {
  if (!shop) return 1
  const saved = readSavedWizardStep(shop.settings)
  if (saved) return saved
  const skipped = shop.settings?.onboarding_number_skipped === true
  if (!shop.twilio_phone_number && !skipped) return 2
  return 3
}

/**
 * Should the dashboard route this shop into the wizard? Only shops
 * explicitly marked onboarding_done:false (set at creation). Older
 * shops have no key and are never gated.
 */
export function needsOnboarding(
  settings: Record<string, unknown> | null | undefined
): boolean {
  return settings?.onboarding_done === false
}

export function carrierApprovalCopy(
  status: A2pRegistrationStatus | "none"
): { label: string; detail: string } {
  switch (status) {
    case "none":
      return {
        label: "Not started",
        detail: "Texting waits until carriers approve your business.",
      }
    case "draft":
      return {
        label: "Saved, not submitted",
        detail: "Finish the form to ask carriers for approval.",
      }
    case "brand_pending":
    case "campaign_pending":
      return {
        label: "Waiting for approval",
        detail: "Review time varies. Check status here; calls have their own setup checks.",
      }
    case "approved":
      return {
        label: "Approved",
        detail: "Carrier registration passed. Consent, message approval and channel controls still apply.",
      }
    case "rejected":
      return {
        label: "Needs a fix",
        detail: "Carriers rejected this registration. Update it and submit again.",
      }
    case "suspended":
      return {
        label: "Suspended",
        detail: "Carriers suspended texting on this number. Texts are paused; contact support.",
      }
  }
}

type A2pStateLike = {
  status: A2pRegistrationState["status"]
  failureReason: string | null
  registration?: A2pRegistrationState
}

/** Prefer the published nextAction. Fall back only when an older caller has a status. */
export function registrationFromA2pState(state: A2pStateLike): A2pRegistrationState {
  if (state.registration) return state.registration
  if (state.status === "none") return describeA2pRegistration(null)
  return describeA2pRegistration({
    status: state.status,
    failed_step: null,
    retryable: null,
    failure_reason: state.failureReason,
    attempts: 0,
  })
}

/**
 * Texting-only status and the one next button. Call setup is never described
 * here. Labels match the onboarding status vocabulary.
 */
export function textingActionCopy(action: A2pNextAction): {
  label: "Not set up" | "Needs your details" | "Submitted for review" | "Needs a correction" | "Ready"
  detail: string
  button: string | null
} {
  switch (action) {
    case "submit":
      return {
        label: "Not set up",
        detail: "Submit your business details for texting approval.",
        button: "Submit for texting approval",
      }
    case "resume":
      return {
        label: "Needs your details",
        detail: "A texting submission stopped. Continue with the same details.",
        button: "Continue texting approval",
      }
    case "fix_and_resubmit":
      return {
        label: "Needs a correction",
        detail: "Carriers refused these details. Correct them and submit again.",
        button: "Fix details and resubmit",
      }
    case "resubmit_campaign":
      return {
        label: "Needs a correction",
        detail: "The business was approved. Submit the texting campaign again.",
        button: "Resubmit texting campaign",
      }
    case "wait":
      return {
        label: "Submitted for review",
        detail: "Texting is with the carriers.",
        button: "Check texting status",
      }
    case "contact_support":
      return {
        label: "Needs a correction",
        detail: "Carriers suspended texting on this number. Texts are paused; contact support. Resubmitting won't lift a suspension.",
        button: "Check texting status",
      }
    case "none":
      return {
        label: "Ready",
        detail: "Carriers approved texting. Consent, approval rules and channel controls still apply.",
        button: null,
      }
  }
}

export function messageApprovalCopy(mode: AutonomyMode): {
  label: string
  detail: string
} {
  if (mode === "autonomous") {
    return {
      label: "Some texts can send",
      detail: "Bookings and quotes still wait for your approval.",
    }
  }
  return {
    label: "Waiting for you",
    detail: "Gradia can draft a text. It does not send until you approve.",
  }
}
