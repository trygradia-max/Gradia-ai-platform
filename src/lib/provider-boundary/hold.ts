/**
 * Provider boundary — durable, content-free hold marker.
 *
 * A held public message keeps its raw evidence exactly where it was already
 * recorded (the customer-role interaction row, and for SMS the intake envelope).
 * The marker is one extra `system`-role thread note per (stage, source message):
 * fixed text, closed reason codes and the provider message reference only — no
 * customer content, no model output. It is evidence, not a proposal: it creates
 * no pending action, lead, customer, draft or send, and is idempotent so a
 * replayed provider event never writes a second marker.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { HoldReason } from "./preflight"

export type HoldStage = "classify" | "draft"

const LABELS: Record<HoldStage, string> = {
  classify: "Held for human review: this message was not classified or answered automatically.",
  draft: "Held for human review: no automatic reply was drafted for this message.",
}

export type RecordHoldInput = {
  shopId: string
  customerId: string | null
  channel: "sms" | "email"
  stage: HoldStage
  /** Provider message reference (MessageSid / Aurinko message id): the replay key. */
  sourceRef: string
  reasons: readonly HoldReason[]
}

export type RecordHoldResult = { ok: true; recorded: boolean } | { ok: false }

export async function recordBoundaryHold(
  supabase: SupabaseClient,
  input: RecordHoldInput,
): Promise<RecordHoldResult> {
  const holdKey = `${input.stage}:${input.sourceRef}`
  const { data: existing, error: lookupErr } = await supabase
    .from("interactions")
    .select("id")
    .eq("shop_id", input.shopId)
    .eq("channel", input.channel)
    .eq("role", "system")
    .eq("metadata->>boundary_hold_key", holdKey)
    .limit(1)
  if (lookupErr) return { ok: false }
  if ((existing?.length ?? 0) > 0) return { ok: true, recorded: false }

  const { error } = await supabase.from("interactions").insert({
    shop_id: input.shopId,
    customer_id: input.customerId,
    channel: input.channel,
    role: "system",
    content: LABELS[input.stage],
    metadata: {
      source: "provider_boundary",
      kind: "hold",
      stage: input.stage,
      boundary_hold_key: holdKey,
      reasons: [...input.reasons],
    },
  })
  return error ? { ok: false } : { ok: true, recorded: true }
}
