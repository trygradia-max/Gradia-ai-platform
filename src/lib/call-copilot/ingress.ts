import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  CALL_COPILOT_PROVIDERS,
  parseCallCopilotEvent,
  type CallCopilotEvent,
  type CallCopilotProvider,
} from "./events"

/**
 * Durable, tenant-isolated, append-only Call Copilot ingress (PR D).
 *
 * One typed door to `call_copilot_record_event`, the only writer of the
 * evidence ledger. The shop id is an explicit server-resolved argument and is
 * never read from the event payload. Replay is decided inside Postgres, from a
 * digest the database computes itself:
 *
 *   recorded     a new event was appended
 *   duplicate    the same event id with identical content (a provider retry)
 *   conflict     the same event id with DIFFERENT content, or a reused
 *                sequence. The database records the conflict and the call
 *                fails closed for capture and for every derived use
 *   foreign_call the provider call id already belongs to another shop
 *   invalid      structurally invalid; nothing was written
 *
 * An unexpected database failure THROWS so the provider retries; an event is
 * never reported accepted unless it is durable.
 */

export class CallCopilotIngressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CallCopilotIngressError"
  }
}

export type CallCopilotIngressResult =
  | {
      outcome: "recorded"
      eventId: string
      callId: string
      digest: string
      status: string
      reason: string
      capturePermittedNow: boolean
    }
  | { outcome: "duplicate"; eventId: string; digest: string }
  | { outcome: "conflict"; conflictKind: "event_id_changed" | "sequence_reused"; digest: string }
  | { outcome: "foreign_call" }
  | { outcome: "invalid" }

const rpcResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("recorded"),
    event_id: z.string().uuid(),
    call_id: z.string().uuid(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.string(),
    reason: z.string(),
    capture_permitted_now: z.boolean(),
  }),
  z.object({
    outcome: z.literal("duplicate"),
    event_id: z.string().uuid(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    outcome: z.literal("conflict"),
    conflict_kind: z.enum(["event_id_changed", "sequence_reused"]),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({ outcome: z.literal("foreign_call") }),
])

/** SQLSTATEs the database raises for a structurally invalid event. */
const INVALID_EVENT_CODES = new Set(["23514", "22023"])

export async function recordCallCopilotEvent(
  db: SupabaseClient,
  input: { shopId: string; provider: CallCopilotProvider; event: unknown },
): Promise<CallCopilotIngressResult> {
  const shopId = z.string().uuid().safeParse(input.shopId)
  const provider = z.enum(CALL_COPILOT_PROVIDERS).safeParse(input.provider)
  const event: CallCopilotEvent | null = parseCallCopilotEvent(input.event)
  if (!shopId.success || !provider.success || !event) return { outcome: "invalid" }

  const { data, error } = await db.rpc("call_copilot_record_event", {
    p_shop_id: shopId.data,
    p_provider: provider.data,
    p_provider_call_id: event.providerCallId,
    p_provider_event_id: event.providerEventId,
    p_sequence: event.sequence,
    p_kind: event.kind,
    p_party: "party" in event ? event.party : null,
    p_disclosure_version: "disclosureVersion" in event ? event.disclosureVersion : null,
    p_responds_to_sequence: "respondsToSequence" in event ? (event.respondsToSequence ?? null) : null,
    p_route_kind: event.kind === "call_opened" ? event.routeKind : null,
    p_operator_region: event.kind === "call_opened" ? (event.operatorRegion ?? null) : null,
    p_caller_region: event.kind === "call_opened" ? (event.callerRegion ?? null) : null,
    p_reason: "reason" in event ? (event.reason ?? null) : null,
    p_occurred_at: event.occurredAt,
  })

  if (error) {
    if (INVALID_EVENT_CODES.has(error.code ?? "")) return { outcome: "invalid" }
    // Message only; never echo the payload.
    throw new CallCopilotIngressError(`Call Copilot event was not recorded (${error.code ?? "unknown"}).`)
  }

  const body = typeof data === "string" ? JSON.parse(data) : data
  const parsed = rpcResultSchema.safeParse(body)
  if (!parsed.success) {
    throw new CallCopilotIngressError("Call Copilot event result could not be read.")
  }
  const r = parsed.data
  switch (r.outcome) {
    case "recorded":
      return {
        outcome: "recorded",
        eventId: r.event_id,
        callId: r.call_id,
        digest: r.digest,
        status: r.status,
        reason: r.reason,
        capturePermittedNow: r.capture_permitted_now,
      }
    case "duplicate":
      return { outcome: "duplicate", eventId: r.event_id, digest: r.digest }
    case "conflict":
      return { outcome: "conflict", conflictKind: r.conflict_kind, digest: r.digest }
    case "foreign_call":
      return { outcome: "foreign_call" }
  }
}
