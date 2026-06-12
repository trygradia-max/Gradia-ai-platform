/**
 * First-run wizard logic (GRADIA_UX_ONBOARDING_SPEC Part 1) — pure, so
 * the resume point and the dashboard gate are testable.
 */

import type { ShopRow } from "@/lib/types/database"

export type WizardStep = 1 | 2 | 3 | 4 | 5

type WizardShopFields = Pick<
  ShopRow,
  "aurinko_account_email" | "twilio_phone_number"
>

/** The wizard resumes at the first incomplete step. Steps 3–5 are
 *  skippable, so "incomplete" is only a starting point — never a wall. */
export function deriveWizardStep(
  shop: WizardShopFields | null,
  serviceCount: number
): WizardStep {
  if (!shop) return 1
  if (serviceCount === 0) return 2
  if (!shop.aurinko_account_email) return 3
  if (!shop.twilio_phone_number) return 4
  return 5
}

/**
 * Should the dashboard route this shop into the wizard? Only shops
 * explicitly marked onboarding_done:false (set at creation since
 * 2026-06-11). Older shops have no key and are never gated.
 */
export function needsOnboarding(
  settings: Record<string, unknown> | null | undefined
): boolean {
  return settings?.onboarding_done === false
}
