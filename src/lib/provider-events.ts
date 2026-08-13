/**
 * Provider-event idempotency claims (P0-005, ADR-001, D-023).
 *
 * The ONE mechanism multi-table webhook handlers use to make provider
 * retries, duplicates, and concurrent deliveries safe: claim
 * (provider, event_id) BEFORE any side effect; process only when the claim
 * says so; mark the claim completed/failed afterward. The decision is
 * durable and database-backed (`provider_events` + row-locked RPCs), so it
 * holds across Vercel instances — never process memory.
 *
 * Consumers: P0-006 (Twilio inbound), P0-007 (Vapi end-of-call), and the
 * Aurinko follow-up. No route in this codebase calls it until those tickets
 * land — P0-005 ships the mechanism only.
 *
 * Contract (enforced by callers, locked by tests):
 *  - Claim STRICTLY AFTER signature verification. An unverified request
 *    must never reach `claimProviderEvent` — at the DB layer the table and
 *    RPCs are service-role-only, so nothing without the service key can
 *    poison a legitimate event id.
 *  - `eventId` must be globally unique within its provider namespace.
 *    Twilio MessageSid and Vapi call.id qualify as-is; per-account ids
 *    (Aurinko) must be prefixed by the caller: `${accountId}:${messageId}`.
 *  - `metadata` is for safe debugging context only — NEVER payload bodies,
 *    auth headers, tokens, signatures, or anything secret-derived.
 *  - Provider/network work stays OUTSIDE the claim call (the RPC is one
 *    short transaction; locks release on return or error).
 *  - A DB failure THROWS (fail closed): the webhook should 5xx so the
 *    provider retries later — an event is never processed unguarded.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export type ProviderEventProvider = "twilio" | "vapi" | "aurinko" | "stripe"

export type ClaimOutcome =
  /** First delivery — caller must process, then complete/fail the claim. */
  | "claimed"
  /** Prior attempt failed — caller reprocesses (attempts incremented). */
  | "reclaimed_failed"
  /** Prior claimer went stale (crashed) — caller reprocesses. */
  | "reclaimed_stale"
  /** Already fully processed — exit with the same success response. */
  | "duplicate_completed"
  /** Another instance is actively processing — exit; it owns the event. */
  | "duplicate_processing"
  /** Failed earlier and retryFailed=false — exit. */
  | "duplicate_failed"

export type ProviderEventClaim = {
  outcome: ClaimOutcome
  /** provider_events row id (null only in a vanishing delete race). */
  id: string | null
  attempts: number
  /** True when the caller owns processing for this delivery. */
  shouldProcess: boolean
}

const PROCESS_OUTCOMES: ReadonlySet<ClaimOutcome> = new Set([
  "claimed",
  "reclaimed_failed",
  "reclaimed_stale",
])

/**
 * Atomically claim one provider event. Insert-first (unique on
 * (provider, event_id)); duplicates are decided under a row lock, so two
 * concurrent identical deliveries always resolve to exactly one
 * `shouldProcess: true`.
 */
export async function claimProviderEvent(
  supabase: SupabaseClient,
  args: {
    provider: ProviderEventProvider
    /** Globally unique within the provider namespace — see module contract. */
    eventId: string
    /** Tenant when resolvable; claims with unresolved tenants still dedupe. */
    shopId?: string | null
    /** Safe debugging keys only — never payloads/headers/secrets. */
    metadata?: Record<string, string | number | boolean | null>
    /** Seconds before an unfinished 'processing' claim is presumed crashed
     *  and taken over. Default 300s — above every webhook maxDuration. */
    staleAfterSeconds?: number
    /** Whether a previously failed event may be reprocessed (default true). */
    retryFailed?: boolean
  }
): Promise<ProviderEventClaim> {
  const { data, error } = await supabase.rpc("claim_provider_event", {
    p_provider: args.provider,
    p_event_id: args.eventId,
    p_shop_id: args.shopId ?? null,
    p_metadata: args.metadata ?? {},
    p_stale_after_seconds: args.staleAfterSeconds ?? 300,
    p_retry_failed: args.retryFailed ?? true,
  })
  if (error) {
    // Fail closed — the caller must NOT process unguarded. Message only;
    // never echo payloads or headers into logs.
    throw new Error(
      `[provider-events] claim failed for ${args.provider}:${args.eventId}: ${error.message}`
    )
  }
  const row = data as { outcome: ClaimOutcome; id: string | null; attempts: number }
  const claim: ProviderEventClaim = {
    outcome: row.outcome,
    id: row.id ?? null,
    attempts: row.attempts ?? 0,
    shouldProcess: PROCESS_OUTCOMES.has(row.outcome),
  }
  if (!claim.shouldProcess) {
    // Duplicate suppression is a NORMAL outcome (info, never an error) —
    // the log line P0-012's metrics will count.
    console.info(
      `[idempotency] duplicate ${args.provider}:${args.eventId} ignored (${claim.outcome})`
    )
  }
  return claim
}

/** Mark a claimed event fully processed. Returns false when no processing
 *  claim matched (e.g. already completed by a racing instance). */
export async function completeProviderEvent(
  supabase: SupabaseClient,
  provider: ProviderEventProvider,
  eventId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc("complete_provider_event", {
    p_provider: provider,
    p_event_id: eventId,
  })
  if (error) {
    // Surfaced, not swallowed: an uncompleted claim is later reclaimable as
    // stale, so the event is not stranded — but the caller must know.
    throw new Error(
      `[provider-events] complete failed for ${provider}:${eventId}: ${error.message}`
    )
  }
  return data === true
}

/**
 * Mark a claimed event failed (durable + observable; the provider's next
 * retry reclaims it when retryFailed). `err` is reduced to its message and
 * truncated — stack traces, payloads, and secrets never reach the row.
 */
export async function failProviderEvent(
  supabase: SupabaseClient,
  provider: ProviderEventProvider,
  eventId: string,
  err: unknown
): Promise<boolean> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
  const { data, error } = await supabase.rpc("fail_provider_event", {
    p_provider: provider,
    p_event_id: eventId,
    p_error: message,
  })
  if (error) {
    throw new Error(
      `[provider-events] fail-mark failed for ${provider}:${eventId}: ${error.message}`
    )
  }
  return data === true
}

/** Postgres unique-violation — exported so ledger writers share one check. */
export function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505"
}
