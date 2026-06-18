/**
 * Plan entitlements — the single source of truth for what a shop's
 * subscription unlocks. Packaging (GRADIA_PRICING.md, reframed 2026-06-15):
 *
 *   Package 1 — Core ($20): on-request Gradia Agent + Whisper. plan = "active".
 *   Package 2 — Voice + Chat Autopilot (+$29): adds autonomous mode + the
 *               voice receptionist. Flagged by shops.voice_addon (flipped by
 *               the Stripe webhook on the add-on subscription item).
 *
 * Fail-closed: `free` and `past_due` get nothing billable — no free packages.
 * Autonomy and voice both require Package 2. These are CODE guardrails, not
 * prompt instructions (locked principle #2): the runtime reads them, so no
 * stored setting or prompt can grant a capability the plan didn't buy.
 */

import type { ShopRow } from "@/lib/types/database"

/**
 * A paying shop on an active subscription. `free` (pre-subscription) and
 * `past_due` (failed payment) are NOT paid — both fail closed.
 */
export function isPaid(shop: Pick<ShopRow, "plan">): boolean {
  return shop.plan === "active"
}

/**
 * Package 2 entitlement — autonomous mode + voice. Requires an active plan
 * AND the +$29 add-on (shops.voice_addon). Without it every agent is
 * suggest-first and the receptionist stays off.
 */
export function hasPackage2(
  shop: Pick<ShopRow, "plan" | "voice_addon">
): boolean {
  return isPaid(shop) && shop.voice_addon === true
}
