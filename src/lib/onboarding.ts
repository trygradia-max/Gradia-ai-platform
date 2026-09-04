/**
 * First-run wizard logic (GRADIA_UX_ONBOARDING_SPEC Part 1) — pure, so
 * the resume point and the dashboard gate are testable.
 */

import { connectionStatus, type ConnectionShopFields } from "@/lib/data/connections"
import { hasCustomWorkingHours } from "@/lib/working-hours"
import type { ShopRow } from "@/lib/types/database"

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6

type WizardShopFields = ConnectionShopFields & Pick<ShopRow, "settings">

/** The wizard resumes at the first incomplete step. Steps 4–6 are
 *  skippable, so "incomplete" is only a starting point — never a wall.
 *  Step 3 (hours) always has a sensible default, so it gates on whether
 *  the owner has ever saved it (B-16), not on any particular value.
 *  Connection truth comes from `connectionStatus()` (UX-001): a mailbox
 *  connected with no display email used to bounce the owner back to step 4
 *  forever. */
export function deriveWizardStep(
  shop: WizardShopFields | null,
  serviceCount: number
): WizardStep {
  if (!shop) return 1
  if (serviceCount === 0) return 2
  if (!hasCustomWorkingHours(shop.settings)) return 3
  const status = connectionStatus(shop)
  if (!status.email.connected) return 4
  if (!status.sms.connected) return 5
  return 6
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
