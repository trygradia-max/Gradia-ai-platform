/**
 * Pipeline (CRM C2) — stage model, timers, and auto-move helpers. Stages are
 * moved by CODE on real events (agent lead → new, quote sent → quote_sent,
 * timer → follow_up, booking approved → booked), never by a model (locked
 * principle #1). All writes are best-effort against pre-C1-migration DBs.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { CrmStage, LeadStatus } from "@/lib/types/database"

export const PIPELINE_STAGES: { key: CrmStage; label: string }[] = [
  { key: "new", label: "New" },
  { key: "needs_quote", label: "Needs quote" },
  { key: "quote_sent", label: "Quote sent" },
  { key: "follow_up", label: "Follow up" },
  { key: "booked", label: "Booked" },
  { key: "lost", label: "Lost" },
]

export const LOST_REASONS = [
  "price",
  "timing",
  "no_response",
  "competitor",
  "other",
] as const
export type LostReason = (typeof LOST_REASONS)[number]

/**
 * Stage-timer defaults (spec §C1.2 — code constants, owner-tunable later):
 * new 5min · needs_quote same-day · quote_sent 2d · follow_up 4d. These set
 * next_action_at on stage entry; the board turns cards amber/red past it.
 */
export const STAGE_TIMER_MINUTES: Record<CrmStage, number | null> = {
  new: 5,
  needs_quote: 8 * 60,
  quote_sent: 2 * 24 * 60,
  follow_up: 4 * 24 * 60,
  booked: null,
  lost: null,
}

export function nextActionAt(stage: CrmStage, from: Date = new Date()): string | null {
  const minutes = STAGE_TIMER_MINUTES[stage]
  if (minutes == null) return null
  return new Date(from.getTime() + minutes * 60_000).toISOString()
}

/** Pre-migration fallback: derive the stage from the legacy lead_status. */
export function stageFromLegacyStatus(status: LeadStatus | string | null): CrmStage {
  switch (status) {
    case "quoted":
      return "quote_sent"
    case "booked":
      return "booked"
    default:
      return "new"
  }
}

export type StageHistoryEntry = {
  from: CrmStage | null
  to: CrmStage
  at: string
  by: "owner" | "system"
}

export function appendStageHistory(
  history: unknown,
  entry: StageHistoryEntry
): StageHistoryEntry[] {
  const prior = Array.isArray(history) ? (history as StageHistoryEntry[]) : []
  return [...prior, entry]
}

/**
 * Best-effort stage move with history + timer. Used by every auto-move hook
 * and the board itself. No-op when the C1 columns are missing or the lead is
 * already there.
 */
export async function moveLeadToStage(
  supabase: SupabaseClient,
  shopId: string,
  leadId: string,
  stage: CrmStage,
  opts: { by?: "owner" | "system"; lostReason?: LostReason | null } = {}
): Promise<boolean> {
  const { data } = await supabase
    .from("leads")
    .select("stage, stage_history")
    .eq("id", leadId)
    .eq("shop_id", shopId)
    .maybeSingle()
  const row = data as { stage: CrmStage | null; stage_history: unknown } | null
  if (!row) return false
  if (row.stage === stage) return true

  const now = new Date()
  const patch: Record<string, unknown> = {
    stage,
    stage_entered_at: now.toISOString(),
    stage_history: appendStageHistory(row.stage_history, {
      from: row.stage,
      to: stage,
      at: now.toISOString(),
      by: opts.by ?? "system",
    }),
    next_action_at: nextActionAt(stage, now),
  }
  if (stage === "lost") patch.lost_reason = opts.lostReason ?? "other"

  const { error } = await supabase
    .from("leads")
    .update(patch)
    .eq("id", leadId)
    .eq("shop_id", shopId)
  if (error) {
    console.warn("[pipeline] stage move skipped (pre-C1?):", error.message)
    return false
  }

  // Keep the legacy status coherent for pre-C2 readers (write-through).
  const legacy: LeadStatus | null =
    stage === "booked" ? "booked" : stage === "quote_sent" ? "quoted" : null
  if (legacy) {
    await supabase
      .from("leads")
      .update({ status: legacy })
      .eq("id", leadId)
      .eq("shop_id", shopId)
  }
  return true
}

/**
 * Timer auto-move (spec C2): quote_sent cards whose next_action_at has
 * passed slide to follow_up. Cron-safe and idempotent; NOT wired into
 * vercel.json (founder picks the slot — same posture as lifecycle.ts).
 */
export async function advanceQuoteFollowUps(
  supabase: SupabaseClient,
  opts: { shopId?: string; now?: Date } = {}
): Promise<{ moved: number; skipped_reason?: string }> {
  const nowIso = (opts.now ?? new Date()).toISOString()
  let q = supabase
    .from("leads")
    .select("id, shop_id")
    .eq("stage", "quote_sent")
    .not("next_action_at", "is", null)
    .lt("next_action_at", nowIso)
    .limit(500)
  if (opts.shopId) q = q.eq("shop_id", opts.shopId)
  const { data, error } = await q
  if (error) {
    return { moved: 0, skipped_reason: `follow-up sweep skipped: ${error.message}` }
  }
  const rows = (data as { id: string; shop_id: string }[] | null) ?? []
  let moved = 0
  for (const row of rows) {
    const ok = await moveLeadToStage(supabase, row.shop_id, row.id, "follow_up", {
      by: "system",
    })
    if (ok) moved += 1
  }
  return { moved }
}
