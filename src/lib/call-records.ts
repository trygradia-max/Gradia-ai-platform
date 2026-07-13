/**
 * Glass Box call capture (redesign spec §8-A6a).
 *
 * Vapi's end-of-call report carries a per-call summary, duration, vendor
 * cost, ended reason, and recording URL that were previously dropped once
 * the call was metered. This persists them as one `call_records` row per
 * call so the call-record page has a real artifact to show.
 *
 * HARD CONTRACT: best-effort, never throws (and never rejects). The Vapi
 * webhook awaits this bare — call handling and billing must never break
 * because capture failed. A lost record is logged and accepted.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export type CallRecordInput = {
  shopId: string
  customerId?: string | null
  vapiCallId: string | null | undefined
  summary?: string | null
  endedReason?: string | null
  recordingUrl?: string | null
  durationSeconds?: number | null
  /** Vapi-reported call cost — display data for the record page, never a billing input. */
  vendorCost?: number | null
  startedAt?: string | null
  endedAt?: string | null
}

export async function persistCallRecord(
  supabase: SupabaseClient,
  input: CallRecordInput
): Promise<void> {
  try {
    const vapiCallId = input.vapiCallId?.trim()
    if (!vapiCallId) {
      // Nothing stable to key the record on — skip rather than invent one.
      console.warn("[call-records] end-of-call report had no call id — skipping capture")
      return
    }
    const { error } = await supabase.from("call_records").upsert(
      {
        shop_id: input.shopId,
        customer_id: input.customerId ?? null,
        vapi_call_id: vapiCallId,
        summary: input.summary?.trim() || null,
        ended_reason: input.endedReason ?? null,
        recording_url: input.recordingUrl ?? null,
        duration_seconds: input.durationSeconds ?? null,
        vendor_cost: input.vendorCost ?? null,
        started_at: input.startedAt ?? null,
        ended_at: input.endedAt ?? null,
      },
      { onConflict: "shop_id,vapi_call_id" }
    )
    if (error) {
      console.error("[call-records] capture failed (call handling unaffected):", error)
    }
  } catch (err) {
    console.error("[call-records] capture threw (call handling unaffected):", err)
  }
}
