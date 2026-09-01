import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { executeApproval } from "@/lib/approvals"
import type { AvailabilitySummary, ConflictOverride } from "@/lib/availability"
import {
  INTEGRATION,
  serviceClient,
  seedShop,
  stagePending,
  getPending,
  cleanup,
  type Seeded,
} from "./_db"

/**
 * P0-004 against real Postgres — the properties a mock can't prove:
 * execution-time re-check on live rows, refusal → atomic rollback with the
 * refreshed conflict written to the card, a documented override executing
 * and leaving audit evidence, D-015 hard-block under automatic context,
 * ends_at persistence, cross-tenant isolation, and replay idempotency.
 *
 * Aurinko is mocked (no live vendor in CI): token resolves, event create
 * returns an id, calendar listing is empty — so the calendar leg of the
 * check reports "checked" with no events, and booking proceeds past the
 * hard Aurinko requirement in the executor.
 */

// The rollout flag (FIX 1) is env-driven and OFF by default; this suite
// tests enforcement, so it runs with the flag explicitly enabled. The getter
// reads process.env at call time, so a plain assignment is enough here.
process.env.NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT = "true"

vi.mock("@/lib/aurinko", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aurinko")>()
  return {
    ...original,
    getAccessTokenForShop: vi.fn(async () => "int-test-token"),
    listCalendarEvents: vi.fn(async () => []),
    // Unique per call — appointments.aurinko_event_id carries a real unique
    // index, exactly like distinct events from the live provider.
    createCalendarEvent: vi.fn(async () => ({
      id: `ev-int-${Math.random().toString(36).slice(2)}`,
      subject: "x",
      start: null,
      end: null,
      location: null,
    })),
    updateCalendarEventTime: vi.fn(async () => undefined),
    deleteCalendarEvent: vi.fn(async () => undefined),
  }
})

// Best-effort side channels stay out of the DB assertions.
vi.mock("@/lib/sms-drafter", () => ({
  draftBookingConfirmationSms: vi.fn(async () => {
    throw new Error("drafter skipped in integration test")
  }),
}))
vi.mock("@/lib/crm-provider", () => ({
  pushBookingToCrm: vi.fn(async () => undefined),
  pushLeadToCrm: vi.fn(async () => undefined),
}))
vi.mock("@/lib/agent-events", () => ({
  dispatchAgentEvent: vi.fn(async () => undefined),
}))

const T0 = "2030-06-03T17:00:00.000Z" // 10:00 PT on a Monday
const T0_END = "2030-06-03T19:00:00.000Z"

function bookingPayload(startIso: string, extras: Record<string, unknown> = {}) {
  return {
    customer_name: "Conflict Casey",
    phone: "+15035550177",
    car_info: null,
    service: "Full Detail",
    iso_start_time: startIso,
    duration_minutes: 120,
    timezone: "UTC",
    email: null,
    pin_notes: null,
    ...extras,
  }
}

async function seedAppointment(
  sb: SupabaseClient,
  shopId: string,
  opts: { start: string; end: string; note?: string | null }
): Promise<string> {
  const { data, error } = await sb
    .from("appointments")
    .insert({
      shop_id: shopId,
      scheduled_at: opts.start,
      ends_at: opts.end,
      duration_minutes: 120,
      service_name: "Seeded",
      internal_note: opts.note ?? null,
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`seedAppointment: ${error?.message}`)
  return data.id as string
}

async function payloadOf(
  sb: SupabaseClient,
  pendingId: string
): Promise<Record<string, unknown>> {
  const { data } = await sb
    .from("pending_actions")
    .select("payload")
    .eq("id", pendingId)
    .single()
  return (data?.payload as Record<string, unknown>) ?? {}
}

async function countAppointments(sb: SupabaseClient, shopId: string): Promise<number> {
  const { count } = await sb
    .from("appointments")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
  return count ?? 0
}

describe.skipIf(!INTEGRATION)("P0-004 conflict enforcement [integration]", () => {
  let sb: SupabaseClient
  let seed: Seeded
  let seedB: Seeded

  beforeAll(async () => {
    sb = serviceClient()
    seed = await seedShop(sb)
    seedB = await seedShop(sb)
  })
  afterAll(async () => {
    if (seed) await cleanup(sb, seed)
    if (seedB) await cleanup(sb, seedB)
  })

  it("HITL approve of an overlapping booking without an override → refused, rolled back, conflicts on the card", async () => {
    const seededId = await seedAppointment(sb, seed.shopId, {
      start: T0,
      end: T0_END,
    })
    const before = await countAppointments(sb, seed.shopId)
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "book_appointment",
      bookingPayload("2030-06-03T18:00:00.000Z")
    )

    const res = await executeApproval(sb, id, seed.shopId, { userId: seed.ownerId })

    expect(res.ok).toBe(false)
    const p = await getPending(sb, id)
    expect(p?.status).toBe("pending") // atomic rollback → re-approvable
    expect(await countAppointments(sb, seed.shopId)).toBe(before)

    const payload = await payloadOf(sb, id)
    const summary = payload.availability as AvailabilitySummary
    expect(summary.conflicts.some((c) => c.key === `appointment:${seededId}`)).toBe(true)
  })

  it("the SAME card with a documented override → books, records audit evidence, then replay is a no-op", async () => {
    const seededId = await seedAppointment(sb, seed.shopId, {
      start: "2030-06-10T17:00:00.000Z",
      end: "2030-06-10T19:00:00.000Z",
    })
    const before = await countAppointments(sb, seed.shopId)
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "book_appointment",
      bookingPayload("2030-06-10T18:00:00.000Z")
    )

    // First approve without override → refused (proves the check ran).
    const refused = await executeApproval(sb, id, seed.shopId, { userId: seed.ownerId })
    expect(refused.ok).toBe(false)

    // Owner overrides exactly as the server action does: actor + timestamp +
    // reason + the conflict keys from the refreshed card.
    const payload = await payloadOf(sb, id)
    const summary = payload.availability as AvailabilitySummary
    const override: ConflictOverride = {
      by: seed.ownerId,
      at: new Date().toISOString(),
      reason: "double-stacking bays on purpose",
      conflicts: summary.conflicts
        .filter((c) => c.severity === "blocking")
        .map((c) => c.key),
    }
    await sb
      .from("pending_actions")
      .update({ payload: { ...payload, conflict_override: override } })
      .eq("id", id)

    const res = await executeApproval(sb, id, seed.shopId, { userId: seed.ownerId })
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ status: "executed", actionType: "book_appointment" })

    // Exactly one appointment landed, with a reliable ends_at (gate 8).
    expect(await countAppointments(sb, seed.shopId)).toBe(before + 1)
    const { data: created } = await sb
      .from("appointments")
      .select("scheduled_at, ends_at")
      .eq("shop_id", seed.shopId)
      .eq("scheduled_at", "2030-06-10T18:00:00+00:00")
      .maybeSingle()
    expect(created).toBeTruthy()
    expect(created?.ends_at).toBeTruthy()

    // Audit evidence: override persisted on the payload + decision-log row.
    const after = await payloadOf(sb, id)
    expect((after.conflict_override as ConflictOverride).by).toBe(seed.ownerId)
    expect((after.conflict_override as ConflictOverride).conflicts).toContain(
      `appointment:${seededId}`
    )
    const { data: decisions } = await sb
      .from("action_decisions")
      .select("source, because, inputs")
      .eq("pending_action_id", id)
      .eq("source", "conflict_override")
    expect(decisions?.length).toBe(1)
    expect(decisions?.[0].because).toContain("overrode")

    // Replay: approving again is already_decided — no duplicate booking.
    const replay = await executeApproval(sb, id, seed.shopId, { userId: seed.ownerId })
    expect(replay).toEqual({ ok: true, status: "already_decided" })
    expect(await countAppointments(sb, seed.shopId)).toBe(before + 1)
  })

  it("automatic context hard-blocks a conflicting booking even WITH an override (D-015)", async () => {
    await seedAppointment(sb, seed.shopId, {
      start: "2030-06-17T17:00:00.000Z",
      end: "2030-06-17T19:00:00.000Z",
    })
    const override: ConflictOverride = {
      by: seed.ownerId,
      at: new Date().toISOString(),
      reason: "should never be honored",
      conflicts: [], // even a fully-covering override must be ignored; keys don't matter
    }
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "book_appointment",
      bookingPayload("2030-06-17T18:00:00.000Z", { conflict_override: override })
    )

    const res = await executeApproval(
      sb,
      id,
      seed.shopId,
      { userId: seed.ownerId },
      { context: "automatic" }
    )
    expect(res.ok).toBe(false)
    const p = await getPending(sb, id)
    expect(p?.status).toBe("pending") // visible refusal — card stays for a human
  })

  it("blocked time refuses a booking the same way", async () => {
    await seedAppointment(sb, seed.shopId, {
      start: "2030-06-24T17:00:00.000Z",
      end: "2030-06-24T19:00:00.000Z",
      note: "[block-time]",
    })
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "book_appointment",
      bookingPayload("2030-06-24T18:00:00.000Z")
    )
    const res = await executeApproval(sb, id, seed.shopId, { userId: seed.ownerId })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("unreachable")
    expect(res.error).toContain("Blocked time")
  })

  it("cross-tenant: shop B's overlapping appointment never blocks shop A (executor-level)", async () => {
    // Overlap exists only in shop B.
    await seedAppointment(sb, seedB.shopId, {
      start: "2030-07-01T17:00:00.000Z",
      end: "2030-07-01T19:00:00.000Z",
    })
    const before = await countAppointments(sb, seed.shopId)
    const id = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "book_appointment",
      bookingPayload("2030-07-01T18:00:00.000Z")
    )
    const res = await executeApproval(sb, id, seed.shopId, { userId: seed.ownerId })
    expect(res.ok).toBe(true)
    expect(await countAppointments(sb, seed.shopId)).toBe(before + 1)
  })

  it("reschedule executor: refuses a move onto a busy slot; a clear move refreshes ends_at", async () => {
    const movingId = await seedAppointment(sb, seed.shopId, {
      start: "2030-07-08T15:00:00.000Z",
      end: "2030-07-08T17:00:00.000Z",
    })
    await seedAppointment(sb, seed.shopId, {
      start: "2030-07-08T18:00:00.000Z",
      end: "2030-07-08T20:00:00.000Z",
    })

    const conflictingMove = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "reschedule_appointment",
      {
        appointment_id: movingId,
        current_scheduled_at: "2030-07-08T15:00:00.000Z",
        service: "Seeded",
        customer_name: null,
        phone: "+15035550177",
        new_when: "7pm",
        iso_new_start_time: "2030-07-08T19:00:00.000Z",
      }
    )
    const refused = await executeApproval(sb, conflictingMove, seed.shopId, {
      userId: seed.ownerId,
    })
    expect(refused.ok).toBe(false)
    expect((await getPending(sb, conflictingMove))?.status).toBe("pending")

    const clearMove = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "reschedule_appointment",
      {
        appointment_id: movingId,
        current_scheduled_at: "2030-07-08T15:00:00.000Z",
        service: "Seeded",
        customer_name: null,
        phone: "+15035550177",
        new_when: "6am",
        iso_new_start_time: "2030-07-08T13:00:00.000Z",
      }
    )
    const res = await executeApproval(sb, clearMove, seed.shopId, { userId: seed.ownerId })
    expect(res.ok).toBe(true)

    const { data: moved } = await sb
      .from("appointments")
      .select("scheduled_at, ends_at")
      .eq("id", movingId)
      .single()
    expect(moved?.scheduled_at).toContain("2030-07-08T13:00:00")
    // ends_at moved WITH the row (gate 8) — 120 min after the new start.
    expect(moved?.ends_at).toContain("2030-07-08T15:00:00")
  })
})
