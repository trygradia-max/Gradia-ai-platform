import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  COMMERCIAL_WEBHOOK_MAX_BODY_BYTES,
  parseVerifiedWebhook,
  payloadDigest,
  resolveCommercialWebhookConfig,
  verifyCommercialSignature,
  type CommercialWebhookConfig,
  type NormalizedEvent,
} from "@/lib/commercial-webhook"

/**
 * Server orchestration of the signed PLATFORM commercial webhook. The route is a
 * thin wrapper so every decision here is testable without HTTP.
 *
 * The database does the work atomically (replay claim, tenant resolution from
 * server-held bindings, evidence, facts, receipt). This layer only verifies the
 * signature over the RAW body, refuses Connect/live shapes, and maps the result.
 * It never logs a payload, a signature, a secret or a Checkout URL.
 */

export type WebhookHttpResult = { status: number; body: Record<string, unknown> }

const ingestSchema = z.object({
  outcome: z.enum(["applied", "not_current", "recorded_fact", "observed", "unresolved", "refused"]),
  reason: z.string().nullable().optional(),
  shop_id: z.string().uuid().nullable().optional(),
  replayed: z.boolean(),
})

export type IngestOutcome =
  | { ok: true; outcome: z.infer<typeof ingestSchema>["outcome"]; replayed: boolean }
  | { ok: false; kind: "conflict" | "invalid" | "failed" }

export async function ingestCommercialWebhook(
  service: SupabaseClient,
  event: NormalizedEvent,
  digest: string
): Promise<IngestOutcome> {
  const { data, error } = await service.rpc("commercial_webhook_ingest", {
    p_event_id: event.eventId,
    p_event_type: event.eventType,
    p_event_created: event.createdIso,
    p_payload_digest: digest,
    p_livemode: false,
    p_facts: event.facts,
  })
  if (error) {
    const kind = error.code === "CB409" ? "conflict" : error.code === "22023" ? "invalid" : "failed"
    return { ok: false, kind }
  }
  const parsed = ingestSchema.safeParse(data)
  if (!parsed.success) return { ok: false, kind: "failed" }
  return { ok: true, outcome: parsed.data.outcome, replayed: parsed.data.replayed }
}

export async function handleCommercialWebhook(
  deps: {
    /** Lazily created so an unconfigured endpoint never touches the database. */
    getService: () => SupabaseClient
    config?: CommercialWebhookConfig
    nowMs?: number
  },
  input: { rawBody: string; signatureHeader: string | null }
): Promise<WebhookHttpResult> {
  const config = deps.config ?? resolveCommercialWebhookConfig()
  // Disabled by default and fail closed on any ambiguity. Retryable once configured.
  if (!config.ok) return { status: 503, body: { received: false, error: config.reason } }

  if (Buffer.byteLength(input.rawBody, "utf8") > COMMERCIAL_WEBHOOK_MAX_BODY_BYTES) {
    return { status: 413, body: { received: false, error: "payload_too_large" } }
  }

  // 1. Signature over the RAW body, before anything is parsed.
  const signature = verifyCommercialSignature({
    rawBody: input.rawBody,
    header: input.signatureHeader,
    secret: config.secret,
    nowMs: deps.nowMs,
  })
  if (!signature.ok) return { status: 400, body: { received: false, error: "invalid_signature" } }

  // 2. Parse, then refuse Connect envelopes and live-mode objects.
  const parsed = parseVerifiedWebhook(input.rawBody)
  if (!parsed.ok) return { status: 400, body: { received: false, error: parsed.code } }
  if (parsed.kind === "ignored") return { status: 200, body: { received: true, outcome: "ignored" } }

  // 3. One atomic database call. A transient failure is a 500 so Stripe retries; the
  //    receipt is written in the same transaction as the effect, so a retry is safe.
  let service: SupabaseClient
  try {
    service = deps.getService()
  } catch {
    return { status: 500, body: { received: false, error: "storage_unavailable" } }
  }
  const result = await ingestCommercialWebhook(service, parsed.event, payloadDigest(input.rawBody))
  if (!result.ok) {
    if (result.kind === "conflict") return { status: 409, body: { received: false, error: "event_conflict" } }
    if (result.kind === "invalid") return { status: 400, body: { received: false, error: "invalid_event" } }
    return { status: 500, body: { received: false, error: "ingest_failed" } }
  }
  return { status: 200, body: { received: true, outcome: result.outcome, replayed: result.replayed } }
}
