import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { enforceRateLimit } from "@/lib/rate-limit"

/**
 * Tier 1 — pure-ish, no network. The limiter is a soft burst guard layered on
 * the hard credit gate: it must deny at/over the limit, allow under it, and
 * fail OPEN on any counter error (never take down inbound/chat).
 */

/** Mock that returns a fixed current count and records the upsert. */
function mockSupabase(input: {
  count?: number
  readError?: boolean
}): { client: SupabaseClient; upserts: unknown[] } {
  const upserts: unknown[] = []
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: input.readError ? null : { count: input.count ?? 0 },
                  error: input.readError ? { message: "boom" } : null,
                }),
            }),
          }),
        }),
      }),
      upsert: (row: unknown) => {
        upserts.push(row)
        return Promise.resolve({ error: null })
      },
    }),
  } as unknown as SupabaseClient
  return { client, upserts }
}

const opts = { limit: 3, windowSeconds: 60 }

describe("enforceRateLimit", () => {
  it("allows under the limit and increments the counter", async () => {
    const { client, upserts } = mockSupabase({ count: 1 })
    const r = await enforceRateLimit("shop-1", "bi_chat", opts, client)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(1) // limit 3 − (1 existing + this one)
    expect(upserts).toHaveLength(1)
  })

  it("denies at the limit without incrementing", async () => {
    const { client, upserts } = mockSupabase({ count: 3 })
    const r = await enforceRateLimit("shop-1", "bi_chat", opts, client)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
    expect(r.resetInSeconds).toBeGreaterThan(0)
    expect(upserts).toHaveLength(0) // over the cap → no bump
  })

  it("fails OPEN when the counter read errors (soft limiter, hard gate is credits)", async () => {
    const { client } = mockSupabase({ readError: true })
    const r = await enforceRateLimit("shop-1", "inbound_classify", opts, client)
    expect(r.allowed).toBe(true)
  })
})
