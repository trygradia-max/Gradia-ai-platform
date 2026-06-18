/**
 * Earned-autonomy telemetry (L6 / brief P4). Tracks how the owner resolves each
 * pending_action — approved unedited, approved after an edit, or rejected — and
 * turns a strong track record into a recommendation: "you've approved texts
 * unedited 47× (96%) — let the agent send them on its own?"
 *
 * Autonomy is granted by EVIDENCE, action type by action type. The money/
 * calendar floors (ALWAYS_HITL) are never eligible no matter the track record,
 * and recommendations only surface for Package 2 shops.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { isAutonomyAllowed, resolveAgentMode } from "@/lib/autonomy"
import { hasPackage2 } from "@/lib/entitlements"
import type { PendingActionType, ShopRow } from "@/lib/types/database"

export type ApprovalResolution =
  | "approved_unedited"
  | "approved_edited"
  | "rejected"
  | "auto"

/** A glance threshold: enough volume + a high unedited rate before we suggest. */
const MIN_DECISIONS = 15
const UNEDITED_THRESHOLD = 0.9
const WINDOW_DAYS = 90

const ACTION_LABELS: Partial<Record<PendingActionType, string>> = {
  send_sms: "texts",
  send_email: "emails",
  add_note: "notes",
  create_lead: "new leads",
}

/** Best-effort: stamp how a pending_action was resolved. Never throws. */
export async function recordApprovalResolution(
  supabase: SupabaseClient,
  pendingId: string,
  resolution: ApprovalResolution
): Promise<void> {
  try {
    const { error } = await supabase
      .from("pending_actions")
      .update({ resolution })
      .eq("id", pendingId)
    if (error) console.error("[trust] resolution stamp failed:", error)
  } catch (err) {
    console.error("[trust] resolution stamp threw:", err)
  }
}

export type ActionTrust = {
  actionType: PendingActionType
  approvedUnedited: number
  approvedEdited: number
  rejected: number
  /** Owner decisions (excludes 'auto'). */
  decisions: number
  uneditedRate: number
}

/** Per-action-type approval stats over the trailing window. */
export async function getTrustStats(
  supabase: SupabaseClient,
  shopId: string
): Promise<ActionTrust[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabase
    .from("pending_actions")
    .select("action_type, resolution")
    .eq("shop_id", shopId)
    .gte("created_at", since)
    .not("resolution", "is", null)
  if (error) {
    console.error("[trust] stats query failed:", error)
    return []
  }
  const rows =
    (data as { action_type: PendingActionType; resolution: ApprovalResolution }[] | null) ?? []

  const by = new Map<PendingActionType, ActionTrust>()
  for (const r of rows) {
    const t =
      by.get(r.action_type) ??
      ({ actionType: r.action_type, approvedUnedited: 0, approvedEdited: 0, rejected: 0, decisions: 0, uneditedRate: 0 } as ActionTrust)
    if (r.resolution === "approved_unedited") t.approvedUnedited += 1
    else if (r.resolution === "approved_edited") t.approvedEdited += 1
    else if (r.resolution === "rejected") t.rejected += 1
    by.set(r.action_type, t)
  }
  for (const t of by.values()) {
    t.decisions = t.approvedUnedited + t.approvedEdited + t.rejected
    t.uneditedRate = t.decisions > 0 ? t.approvedUnedited / t.decisions : 0
  }
  return [...by.values()]
}

export type AutonomyRecommendation = {
  actionType: PendingActionType
  label: string
  decisions: number
  uneditedRate: number
}

/**
 * Which action types have earned an autopilot offer: not a HITL-floor type,
 * enough volume, a high unedited rate, not already autonomous — and only when
 * the shop has Package 2 (autonomy is a paid capability).
 */
export function getAutonomyRecommendations(
  shop: Pick<ShopRow, "settings" | "plan" | "voice_addon">,
  stats: ActionTrust[]
): AutonomyRecommendation[] {
  if (!hasPackage2(shop)) return []
  return stats
    .filter((s) => isAutonomyAllowed(s.actionType))
    .filter((s) => s.decisions >= MIN_DECISIONS)
    .filter((s) => s.uneditedRate >= UNEDITED_THRESHOLD)
    .filter((s) => resolveAgentMode(shop, s.actionType) !== "autonomous")
    .map((s) => ({
      actionType: s.actionType,
      label: ACTION_LABELS[s.actionType] ?? s.actionType,
      decisions: s.decisions,
      uneditedRate: s.uneditedRate,
    }))
}
