/**
 * Provider boundary — durable, content-free hold marker.
 *
 * A held public message keeps its raw evidence exactly where it was already
 * recorded (the customer-role interaction row, and for SMS the intake envelope).
 * The marker is one extra `system`-role thread note per (stage, source message):
 * fixed text, closed reason codes and the provider message reference only — no
 * customer content, no model output. It is evidence, not a proposal: it creates
 * no pending action, lead, customer, draft or send, and is idempotent so a
 * replayed or simultaneously duplicated provider event never writes a second marker (a
 * partial unique index makes the single INSERT atomic).
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

/** Postgres unique_violation, surfaced by PostgREST as `error.code`. */
const UNIQUE_VIOLATION = "23505"

export async function recordBoundaryHold(
  supabase: SupabaseClient,
  input: RecordHoldInput,
): Promise<RecordHoldResult> {
  // One atomic INSERT. Exactly-once is enforced by the partial unique index
  // `interactions_provider_boundary_hold_unique` (shop_id, channel, boundary_hold_key), not by a
  // lookup: a check-then-insert lets two simultaneous deliveries of the same provider message
  // both pass the check. The loser gets 23505, which means "already recorded", not a failure.
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
      boundary_hold_key: `${input.stage}:${input.sourceRef}`,
      reasons: [...input.reasons],
    },
  })
  if (!error) return { ok: true, recorded: true }
  if (error.code === UNIQUE_VIOLATION) return { ok: true, recorded: false }
  return { ok: false }
}
