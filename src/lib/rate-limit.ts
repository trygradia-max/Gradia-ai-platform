/**
 * Per-shop rate limiter — a soft burst/abuse smoother layered on top of the
 * hard credit gate (lib/credits.ts). The credit allowance is the real cost
 * ceiling and fails CLOSED; this limiter fails OPEN on any counter outage so a
 * limiter hiccup can never take down inbound handling or the owner's chat.
 *
 * Two jobs:
 *   1. Cap the one UNMETERED cost path — inbound SMS/email classification —
 *      against spam floods (a per-shop daily ceiling). Over the ceiling the
 *      message is still captured; only the LLM classify is skipped.
 *   2. Smooth bursts on the owner-facing metered endpoints (Gradia Agent /
 *      Ask Gradia, Whisper) so a hot loop can't hammer our vendors or burn a
 *      shop's whole allowance in seconds.
 *
 * Counters are fixed-window and tamper-proof (service-role table, RLS-locked).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceClient } from "@/lib/supabase/service"

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetInSeconds: number
}

/**
 * Named limits. Tunable per pilot feedback. Inbound classify is a DAILY
 * spam-flood ceiling (the only uncapped cost path); the owner buckets are
 * per-minute burst guards on top of the credit gate.
 */
export const RATE_LIMITS = {
  inbound_classify: { limit: 400, windowSeconds: 86_400 },
  bi_chat: { limit: 20, windowSeconds: 60 },
  agent_chat: { limit: 20, windowSeconds: 60 },
  whisper: { limit: 20, windowSeconds: 60 },
} as const

export type RateLimitBucket = keyof typeof RATE_LIMITS

function windowBounds(windowSeconds: number): {
  windowStart: string
  resetInSeconds: number
} {
  const now = Date.now()
  const windowMs = windowSeconds * 1000
  const startMs = Math.floor(now / windowMs) * windowMs
  return {
    windowStart: new Date(startMs).toISOString(),
    resetInSeconds: Math.ceil((startMs + windowMs - now) / 1000),
  }
}

/**
 * Core limiter. Race-tolerant (a few extra under contention is fine for a soft
 * limit) and fail-open — the credit gate is the hard ceiling, not this.
 */
export async function enforceRateLimit(
  shopId: string,
  bucket: string,
  opts: { limit: number; windowSeconds: number },
  /** Injectable for tests; defaults to the tamper-proof service client. */
  client?: SupabaseClient
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = opts
  const { windowStart, resetInSeconds } = windowBounds(windowSeconds)
  const allow = (remaining: number): RateLimitResult => ({
    allowed: true,
    remaining,
    resetInSeconds,
  })

  let supabase: SupabaseClient
  try {
    supabase = client ?? createServiceClient()
  } catch {
    return allow(limit) // no service client configured → don't block
  }

  const { data, error } = await supabase
    .from("rate_limits")
    .select("count")
    .eq("shop_id", shopId)
    .eq("bucket", bucket)
    .eq("window_start", windowStart)
    .maybeSingle()
  if (error) {
    console.error("[rate-limit] read failed, allowing:", error)
    return allow(limit)
  }

  const current = (data as { count: number } | null)?.count ?? 0
  if (current >= limit) {
    return { allowed: false, remaining: 0, resetInSeconds }
  }

  // Best-effort increment — a failed bump must not reject the request.
  const { error: upErr } = await supabase
    .from("rate_limits")
    .upsert(
      { shop_id: shopId, bucket, window_start: windowStart, count: current + 1 },
      { onConflict: "shop_id,bucket,window_start" }
    )
  if (upErr) console.error("[rate-limit] bump failed:", upErr)

  return allow(Math.max(0, limit - current - 1))
}

/** Convenience wrapper for the named buckets above. */
export async function checkRateLimit(
  shopId: string,
  bucket: RateLimitBucket
): Promise<RateLimitResult> {
  return enforceRateLimit(shopId, bucket, RATE_LIMITS[bucket])
}
