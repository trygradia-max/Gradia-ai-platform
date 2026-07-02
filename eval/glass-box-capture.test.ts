import { describe, it, expect } from "vitest"

import type { SupabaseClient } from "@supabase/supabase-js"

import { persistCallRecord } from "@/lib/call-records"
import { recordActionDecision } from "@/lib/decision-log"

/**
 * Tier 1 — pure, deterministic. Locks the Glass Box capture fence
 * (redesign spec §8-A6): capture is best-effort and can NEVER fail its
 * caller. The Vapi webhook and every staging path await these helpers
 * bare — so "resolves, never rejects, even when the DB write explodes"
 * is exactly the property that keeps a capture failure from failing
 * call handling, staging, or billing. If one of these tests starts
 * failing, a capture path has grown a way to throw — fix the helper,
 * never wrap the webhook.
 */

type Captured = { table: string; row: Record<string, unknown>; options?: unknown }

/** Happy-path mock: records what was written. */
function capturingSupabase(captured: Captured[]): SupabaseClient {
  return {
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, options?: unknown) => {
        captured.push({ table, row, options })
        return Promise.resolve({ data: null, error: null })
      },
      insert: (row: Record<string, unknown>) => {
        captured.push({ table, row })
        return Promise.resolve({ data: null, error: null })
      },
    }),
  } as unknown as SupabaseClient
}

/** DB says no: every write resolves with an error object. */
function erroringSupabase(): SupabaseClient {
  const failed = { data: null, error: { message: "relation does not exist" } }
  return {
    from: () => ({
      upsert: () => Promise.resolve(failed),
      insert: () => Promise.resolve(failed),
    }),
  } as unknown as SupabaseClient
}

/** Client blows up synchronously (worst case: misconfigured client). */
function throwingSupabase(): SupabaseClient {
  return {
    from: () => {
      throw new Error("connection refused")
    },
  } as unknown as SupabaseClient
}

/** Write rejects (network-level failure mid-flight). */
function rejectingSupabase(): SupabaseClient {
  return {
    from: () => ({
      upsert: () => Promise.reject(new Error("fetch failed")),
      insert: () => Promise.reject(new Error("fetch failed")),
    }),
  } as unknown as SupabaseClient
}

const CALL_INPUT = {
  shopId: "shop-1",
  customerId: "cust-1",
  vapiCallId: "call-abc",
  summary: "Caller booked an oil change for Friday.",
  endedReason: "customer-ended-call",
  recordingUrl: "https://vapi.example/rec.wav",
  durationSeconds: 142,
  vendorCost: 0.37,
  startedAt: "2026-07-02T17:00:00Z",
  endedAt: "2026-07-02T17:02:22Z",
}

const DECISION_INPUT = {
  shopId: "shop-1",
  pendingActionId: "pa-1",
  source: "voice",
  because: "Staged because the caller asked to cancel their appointment.",
  inputs: { rule: "voice_cancel_appointment" },
}

describe("persistCallRecord — captures the end-of-call artifact", () => {
  it("upserts one call_records row keyed by (shop_id, vapi_call_id)", async () => {
    const captured: Captured[] = []
    await persistCallRecord(capturingSupabase(captured), CALL_INPUT)
    expect(captured).toHaveLength(1)
    expect(captured[0].table).toBe("call_records")
    expect(captured[0].options).toEqual({ onConflict: "shop_id,vapi_call_id" })
    expect(captured[0].row).toMatchObject({
      shop_id: "shop-1",
      customer_id: "cust-1",
      vapi_call_id: "call-abc",
      summary: "Caller booked an oil change for Friday.",
      ended_reason: "customer-ended-call",
      recording_url: "https://vapi.example/rec.wav",
      duration_seconds: 142,
      vendor_cost: 0.37,
    })
  })

  it("skips (writes nothing) when the report has no call id — no invented keys", async () => {
    const captured: Captured[] = []
    await persistCallRecord(capturingSupabase(captured), {
      ...CALL_INPUT,
      vapiCallId: "  ",
    })
    expect(captured).toHaveLength(0)
  })
})

describe("the §8-A6 fence — a failed capture never fails the webhook", () => {
  it("persistCallRecord resolves when the write returns a DB error", async () => {
    await expect(
      persistCallRecord(erroringSupabase(), CALL_INPUT)
    ).resolves.toBeUndefined()
  })

  it("persistCallRecord resolves when the client throws synchronously", async () => {
    await expect(
      persistCallRecord(throwingSupabase(), CALL_INPUT)
    ).resolves.toBeUndefined()
  })

  it("persistCallRecord resolves when the write rejects mid-flight", async () => {
    await expect(
      persistCallRecord(rejectingSupabase(), CALL_INPUT)
    ).resolves.toBeUndefined()
  })

  it("recordActionDecision resolves when the write returns a DB error", async () => {
    await expect(
      recordActionDecision(erroringSupabase(), DECISION_INPUT)
    ).resolves.toBeUndefined()
  })

  it("recordActionDecision resolves when the client throws synchronously", async () => {
    await expect(
      recordActionDecision(throwingSupabase(), DECISION_INPUT)
    ).resolves.toBeUndefined()
  })

  it("recordActionDecision resolves when the write rejects mid-flight", async () => {
    await expect(
      recordActionDecision(rejectingSupabase(), DECISION_INPUT)
    ).resolves.toBeUndefined()
  })
})

describe("recordActionDecision — writes the 'because' line", () => {
  it("inserts one action_decisions row with the sentence and its inputs", async () => {
    const captured: Captured[] = []
    await recordActionDecision(capturingSupabase(captured), DECISION_INPUT)
    expect(captured).toHaveLength(1)
    expect(captured[0].table).toBe("action_decisions")
    expect(captured[0].row).toMatchObject({
      shop_id: "shop-1",
      pending_action_id: "pa-1",
      source: "voice",
      because: "Staged because the caller asked to cancel their appointment.",
      inputs: { rule: "voice_cancel_appointment" },
    })
  })
})
