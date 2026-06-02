/**
 * Autonomy model (BUILD_REFERENCE §5) — the product's trust dial.
 *
 * Every agent runs in one of two modes:
 *   - "suggest"    — drafts, a human approves, then it sends (default, HITL).
 *   - "autonomous" — acts immediately, then logs what it did.
 *
 * Resolution is a global default + per-agent overrides, stored on
 * `shops.settings.autonomy` (no dedicated table). Some action types are ALWAYS
 * human-approved regardless of mode — the per-action floor below.
 *
 * Chunk 1 ships the config + controls; the runtime that auto-executes in
 * autonomous mode (and the ActivityEvent render) lands in Chunk 3.
 */

import type { PendingActionType, ShopRow } from "@/lib/types/database"

export type AutonomyMode = "suggest" | "autonomous"

/**
 * Always human-approved regardless of mode — irreversible, money-moving, or
 * calendar-writing. Honors the "every customer-facing money/calendar action is
 * reviewed" promise even when an agent is otherwise autonomous.
 */
export const ALWAYS_HITL: ReadonlySet<PendingActionType> = new Set([
  "book_appointment",
  "charge_customer",
])

export function isAutonomyAllowed(actionType: PendingActionType): boolean {
  return !ALWAYS_HITL.has(actionType)
}

export type AutonomyConfig = {
  default: AutonomyMode
  overrides: Record<string, AutonomyMode>
}

function asMode(value: unknown): AutonomyMode | null {
  return value === "suggest" || value === "autonomous" ? value : null
}

/** Reads the shop's autonomy config, tolerating missing/partial settings. */
export function readAutonomy(
  shop: Pick<ShopRow, "settings"> | null
): AutonomyConfig {
  const raw = (
    shop?.settings as { autonomy?: Partial<AutonomyConfig> } | null
  )?.autonomy
  const overrides: Record<string, AutonomyMode> = {}
  if (raw?.overrides && typeof raw.overrides === "object") {
    for (const [key, value] of Object.entries(raw.overrides)) {
      const mode = asMode(value)
      if (mode) overrides[key] = mode
    }
  }
  return { default: asMode(raw?.default) ?? "suggest", overrides }
}

/** Effective mode for a given agent key (override → global default). */
export function resolveAgentMode(
  shop: Pick<ShopRow, "settings"> | null,
  agentKey: string
): AutonomyMode {
  const cfg = readAutonomy(shop)
  return cfg.overrides[agentKey] ?? cfg.default
}
