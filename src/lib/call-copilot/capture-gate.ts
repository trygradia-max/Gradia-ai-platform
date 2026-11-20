import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  CALL_COPILOT_LIVE_PURPOSES,
  CALL_COPILOT_PROVIDERS,
  type CallCopilotCapturePurpose,
  type CallCopilotProvider,
} from "./events"

/**
 * The Call Copilot capture gate (PR D): deny by default.
 *
 * Recording, transcription, model use, summarization, extraction and CRM
 * mutation for a call must each obtain a `CaptureGrant` from
 * `requireCaptureGrant` first. The grant is issued only when the database's
 * order-independent consent fold says both parties were disclosed to and
 * consented, and nothing since (pause, stop, decline, an extra participant, a
 * replay conflict, a missing sequence) has withdrawn or clouded that consent.
 * Declined, missing, unavailable or uncertain consent, and any failure to
 * ask, all deny. There is no other way to obtain a grant.
 *
 * A grant is a NECESSARY condition only. It says nothing about the shop's
 * Control Center policy, approval or CRM authority, which a later PR must AND
 * with it. It also does not claim a recording is complete.
 */

declare const captureGrantBrand: unique symbol

export type CaptureGrant = Readonly<{
  readonly [captureGrantBrand]: true
  shopId: string
  callId: string
  purpose: CallCopilotCapturePurpose
  at: string | null
  state: CaptureState
}>

export class CaptureDeniedError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`Call Copilot capture is not permitted (${reason}).`)
    this.name = "CaptureDeniedError"
    this.reason = reason
  }
}

const intervalSchema = z.object({
  started_sequence: z.number().int(),
  started_at: z.string(),
  ended_sequence: z.number().int().nullable(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
})
const gapSchema = z.object({
  started_sequence: z.number().int(),
  started_at: z.string(),
  ended_sequence: z.number().int().nullable(),
  ended_at: z.string().nullable(),
  reason: z.string(),
})

const stateSchema = z.object({
  status: z.enum([
    "unknown_call", "awaiting_consent", "active", "paused", "declined",
    "stopped", "ended", "unknown_outcome", "uncertain",
  ]),
  reason: z.string(),
  capture_permitted_now: z.boolean(),
  derivation_permitted: z.boolean(),
  call_ended: z.boolean(),
  outcome_unknown: z.boolean(),
  contiguous_through: z.number().int(),
  highest_sequence: z.number().int(),
  unresolved_gap: z.boolean(),
  conflict_count: z.number().int(),
  intervals: z.array(intervalSchema),
  gaps: z.array(gapSchema),
  ignored: z.array(z.object({ sequence: z.number().int(), reason: z.string() })),
})

export type CaptureState = {
  status: z.infer<typeof stateSchema>["status"]
  reason: string
  capturePermittedNow: boolean
  derivationPermitted: boolean
  callEnded: boolean
  outcomeUnknown: boolean
  contiguousThrough: number
  highestSequence: number
  unresolvedGap: boolean
  conflictCount: number
  /** Consented spans. Audio exists only inside these. */
  intervals: { startedSequence: number; startedAt: string; endedSequence: number | null; endedAt: string | null; endReason: string | null }[]
  /** Explicit uncaptured spans (before consent, pause, stop, unknown outcome). Never backfilled. */
  gaps: { startedSequence: number; startedAt: string; endedSequence: number | null; endedAt: string | null; reason: string }[]
  /** Events recorded but ineffective (for example a consent that cites no matching disclosure). */
  ignored: { sequence: number; reason: string }[]
}

function toState(raw: z.infer<typeof stateSchema>): CaptureState {
  return {
    status: raw.status,
    reason: raw.reason,
    capturePermittedNow: raw.capture_permitted_now,
    derivationPermitted: raw.derivation_permitted,
    callEnded: raw.call_ended,
    outcomeUnknown: raw.outcome_unknown,
    contiguousThrough: raw.contiguous_through,
    highestSequence: raw.highest_sequence,
    unresolvedGap: raw.unresolved_gap,
    conflictCount: raw.conflict_count,
    intervals: raw.intervals.map((i) => ({
      startedSequence: i.started_sequence, startedAt: i.started_at,
      endedSequence: i.ended_sequence, endedAt: i.ended_at, endReason: i.end_reason,
    })),
    gaps: raw.gaps.map((g) => ({
      startedSequence: g.started_sequence, startedAt: g.started_at,
      endedSequence: g.ended_sequence, endedAt: g.ended_at, reason: g.reason,
    })),
    ignored: raw.ignored,
  }
}

/**
 * Resolve the Gradia call id for a provider call id, scoped to the shop.
 * Returns null for an unknown call or another shop's call: a forged call id
 * is indistinguishable from a missing one.
 */
export async function findCallCopilotCallId(
  db: SupabaseClient,
  input: { shopId: string; provider: CallCopilotProvider; providerCallId: string },
): Promise<string | null> {
  const provider = z.enum(CALL_COPILOT_PROVIDERS).safeParse(input.provider)
  if (!provider.success) return null
  const { data, error } = await db
    .from("call_copilot_calls")
    .select("id")
    .eq("shop_id", input.shopId)
    .eq("provider", provider.data)
    .eq("provider_call_id", input.providerCallId)
    .maybeSingle()
  if (error) throw new Error(`Call Copilot call lookup failed (${error.code ?? "unknown"}).`)
  return (data as { id: string } | null)?.id ?? null
}

/** Read the consent/capture state. Throws when it cannot be read: callers must treat that as denial. */
export async function readCaptureState(
  db: SupabaseClient,
  input: { shopId: string; callId: string },
): Promise<CaptureState> {
  const { data, error } = await db.rpc("call_copilot_capture_state", {
    p_shop_id: input.shopId,
    p_call_id: input.callId,
  })
  if (error) throw new Error(`Call Copilot state could not be read (${error.code ?? "unknown"}).`)
  const parsed = stateSchema.safeParse(typeof data === "string" ? JSON.parse(data) : data)
  if (!parsed.success) throw new Error("Call Copilot state could not be read.")
  return toState(parsed.data)
}

/**
 * Issue a grant or throw `CaptureDeniedError`. Any failure to ask (database
 * error, unreadable answer) is a denial, never a default allow.
 *
 * `at` is optional. For live purposes it must not precede the current
 * consented interval; for derived purposes it must fall inside a captured
 * interval, so an uncaptured gap can never be backfilled.
 */
export async function requireCaptureGrant(
  db: SupabaseClient,
  input: { shopId: string; callId: string; purpose: CallCopilotCapturePurpose; at?: string },
): Promise<CaptureGrant> {
  const { data, error } = await db.rpc("call_copilot_assert_capture", {
    p_shop_id: input.shopId,
    p_call_id: input.callId,
    p_purpose: input.purpose,
    p_at: input.at ?? null,
  })
  if (error) {
    if (error.code === "CC403") {
      throw new CaptureDeniedError(error.details?.trim() || "capture_not_permitted")
    }
    throw new CaptureDeniedError("gate_unavailable")
  }
  const parsed = stateSchema.safeParse(typeof data === "string" ? JSON.parse(data) : data)
  if (!parsed.success) throw new CaptureDeniedError("gate_unreadable")
  const state = toState(parsed.data)
  const live = (CALL_COPILOT_LIVE_PURPOSES as readonly string[]).includes(input.purpose)
  // Belt and braces: the database already decided; refuse an answer that contradicts the purpose.
  if (live ? !state.capturePermittedNow : !state.derivationPermitted) {
    throw new CaptureDeniedError("gate_inconsistent")
  }
  return Object.freeze({
    shopId: input.shopId,
    callId: input.callId,
    purpose: input.purpose,
    at: input.at ?? null,
    state,
  }) as CaptureGrant
}
