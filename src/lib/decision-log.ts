/**
 * Glass Box decision log (redesign spec §8-A6b).
 *
 * One `action_decisions` row per staged pending_action recording WHY the
 * action was staged — the "because" line the Activity feed renders. The
 * sentence cites only observable, in-scope facts (the rule that fired, the
 * data that matched); `inputs` carries those facts as JSON. The UI shows a
 * decision line ONLY where a row exists — never reconstructed, never
 * invented (Language Pack §2, spec §5.1).
 *
 * HARD CONTRACT: best-effort, never throws (and never rejects). Staging
 * paths await this bare, after the pending_action insert has succeeded —
 * a lost decision line must never lose the staged action itself.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export type ActionDecisionInput = {
  shopId: string
  pendingActionId: string
  /** Mirrors the pending_action payload.source ("custom_agent", "voice", …). */
  source: string
  /** One plain-English past-tense sentence: [action] because [rule/data]. */
  because: string
  /** The observable facts behind the sentence (rule key, ids, thresholds). */
  inputs?: Record<string, unknown>
}

export async function recordActionDecision(
  supabase: SupabaseClient,
  input: ActionDecisionInput
): Promise<void> {
  try {
    const { error } = await supabase.from("action_decisions").insert({
      shop_id: input.shopId,
      pending_action_id: input.pendingActionId,
      source: input.source,
      because: input.because,
      inputs: input.inputs ?? {},
    })
    if (error) {
      console.error("[decision-log] write failed (staging unaffected):", error)
    }
  } catch (err) {
    console.error("[decision-log] write threw (staging unaffected):", err)
  }
}
