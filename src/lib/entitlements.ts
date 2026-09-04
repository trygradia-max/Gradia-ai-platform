/**
 * Plan entitlements — the single source of truth for what a shop's
 * subscription unlocks. Packaging (P0-013 — D-031 / D-034, `_docs/GRADIA_PRICING.md`):
 *
 *   Core ($99)     — full CRM + Gradia Agent + Whisper + Ask Gradia + approvals +
 *                    imports. Suggest-first only. No voice.
 *   Pro ($149)     — adds the voice receptionist + business number and EARNED
 *                    autonomy (per agent, reversible; money + calendar always ask).
 *   Operator ($249)— adds team seats / multi-user and priority support.
 *
 * `plan` is subscription STATUS (free | active | past_due); `tier` is WHICH
 * plan. Fail-closed: `free` and `past_due` get nothing billable — no free
 * packages, whatever the tier says. These are CODE guardrails, not prompt
 * instructions (locked principle #2): the runtime reads them, so no stored
 * setting or prompt can grant a capability the plan didn't buy.
 *
 * Transition note: `shops.voice_addon` is the retired +$29 add-on flag. It is
 * still honored as a voice/autonomy override for a paid shop so that this
 * deploy can never silently remove a capability a pilot shop was hand-granted;
 * the webhook no longer writes it. The founder decides when to clear it
 * (P0-013 close record).
 */

import { PLAN, tierSpec } from "@/lib/pricing"
import type { ShopRow, ShopTier } from "@/lib/types/database"

export type EntitlementFields = Pick<ShopRow, "plan" | "tier" | "voice_addon">
export type AllowanceFields = Pick<ShopRow, "plan" | "tier" | "voice_addon" | "trial_ends_at">

/**
 * A paying shop on an active subscription. `free` (pre-subscription) and
 * `past_due` (failed payment) are NOT paid — both fail closed. A Stripe
 * trial maps to `active` (the webhook's status mapping), so a trialing shop
 * is paid here and its ALLOWANCE is what the trial numbers shrink.
 */
export function isPaid(shop: Pick<ShopRow, "plan">): boolean {
  return shop.plan === "active"
}

/** The shop's tier, defensively — an unexpected value reads as Core. */
export function shopTier(shop: Pick<ShopRow, "tier">): ShopTier {
  return tierSpec(shop.tier).key
}

/** Voice receptionist + business number: Pro and Operator (or the retired
 *  add-on flag, transition-only), and only while paid. */
export function hasVoice(shop: EntitlementFields): boolean {
  if (!isPaid(shop)) return false
  return tierSpec(shop.tier).voice || shop.voice_addon === true
}

/** Earned autonomy (suggest → act): Pro and Operator (or the retired add-on
 *  flag, transition-only), and only while paid. ALWAYS_HITL still applies on
 *  top — money + calendar ask in every tier. */
export function hasAutonomy(shop: EntitlementFields): boolean {
  if (!isPaid(shop)) return false
  return tierSpec(shop.tier).autonomy || shop.voice_addon === true
}

/** Team seats / multi-user operations: Operator only, while paid. */
export function hasTeamSeats(shop: Pick<ShopRow, "plan" | "tier">): boolean {
  return isPaid(shop) && tierSpec(shop.tier).teamSeats
}

/** True while a Stripe trial is running on a paid (trialing) subscription. */
export function isInTrial(
  shop: Pick<ShopRow, "plan" | "trial_ends_at">,
  now: Date = new Date()
): boolean {
  if (!isPaid(shop) || !shop.trial_ends_at) return false
  const ends = new Date(shop.trial_ends_at).getTime()
  return Number.isFinite(ends) && ends > now.getTime()
}

/**
 * Message credits included this period: the tier's allowance while paid,
 * the D-035 trial allowance while the trial runs, nothing otherwise. Packs
 * and rollover are added by lib/credits.ts on top.
 */
export function includedCreditsThisPeriod(
  shop: Pick<ShopRow, "plan" | "tier" | "trial_ends_at">,
  now: Date = new Date()
): number {
  if (!isPaid(shop)) return 0
  if (isInTrial(shop, now)) return PLAN.TRIAL.credits
  return tierSpec(shop.tier).includedCredits
}

/**
 * Voice minutes included this period: the tier's minutes while the shop has
 * voice, the trial minutes while the trial runs, nothing otherwise. A shop
 * that has voice only through the retired add-on flag gets the minutes its
 * TIER includes (Core = 0) plus any packs — the transition never re-creates
 * the $29 bundle.
 */
export function includedMinutesThisPeriod(
  shop: AllowanceFields,
  now: Date = new Date()
): number {
  if (!hasVoice(shop)) return 0
  if (isInTrial(shop, now)) return PLAN.TRIAL.minutes
  return tierSpec(shop.tier).includedMinutes
}
