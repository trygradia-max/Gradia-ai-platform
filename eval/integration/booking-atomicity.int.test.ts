import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { executeApproval } from "@/lib/approvals"
import * as aurinko from "@/lib/aurinko"
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
 * P0-004A (issue #13) against real Postgres — the proofs a mock can't give:
 * the advisory-lock serialization actually closes the check→insert TOCTOU
 * race under genuinely concurrent connections, replay of an approved action
 * never duplicates an appointment, refusal leaves the pending action
 * coherent with no partial rows, capacity > 1 survives via documented
 * overrides, tenants never block each other, and an external-calendar
 * failure after persistence leaves the Gradia booking standing.
 *
 * Aurinko is mocked at the provider boundary (no live vendor in CI); real
 * Postgres carries every database-critical behavior.
 */

// Env-driven rollout flag (FIX 1) is OFF by default; this suite tests the
// enforcement machinery, so it runs with the flag enabled.
process.env.NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT = "true"

vi.mock("@/lib/aurinko", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/aurinko")>()
  return {
    ...original,
    getAccessTokenForShop: vi.fn(async () => "int-test-token"),
    listCalendarEvents: vi.fn(async () => []),
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

const mockedCreateEvent = vi.mocked(aurinko.createCalendarEvent)

function bookingPayload(startIso: string, extras: Record<string, unknown> = {}) {
  return {
    customer_name: "Atomic Avery",
    phone: "+15035550166",
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

/** Distinct 2h slots on far-apart days so tests never collide. */
let slotCounter = 0
function freshSlot(): { start: string; end: string } {
  slotCounter += 1
  const base = Date.parse("2031-01-05T17:00:00.000Z") + slotCounter * 72 * 60 * 60_000
  return {
    start: new Date(base).toISOString(),
    end: new Date(base + 2 * 60 * 60_000).toISOString(),
  }
}

async function appointmentsInSlot(
  sb: SupabaseClient,
  shopId: string,
  slot: { start: string; end: string }
): Promise<Array<{ id: string; pending_action_id: string | null }>> {
  const { data } = await sb
    .from("appointments")
    .select("id, pending_action_id")
    .eq("shop_id", shopId)
    .gte("scheduled_at", slot.start)
    .lt("scheduled_at", slot.end)
  return (data as Array<{ id: string; pending_action_id: string | null }> | null) ?? []
}

async function overrideDecisions(
  sb: SupabaseClient,
  pendingId: string
): Promise<number> {
  const { count } = await sb
    .from("action_decisions")
    .select("*", { count: "exact", head: true })
    .eq("pending_action_id", pendingId)
    .eq("source", "conflict_override")
  return count ?? 0
}

describe.skipIf(!INTEGRATION)("P0-004A booking atomicity [integration]", () => {
  let sb: SupabaseClient
  let sb2: SupabaseClient // second client = second connection for true concurrency
  let seed: Seeded
  let seedB: Seeded

  beforeAll(async () => {
    sb = serviceClient()
    sb2 = serviceClient()
    seed = await seedShop(sb)
    seedB = await seedShop(sb)
  })
  afterAll(async () => {
    if (seed) await cleanup(sb, seed)
    if (seedB) await cleanup(sb, seedB)
  })

  it("successful booking persists exactly once, stamped with its pending_action_id", async () => {
    const slot = freshSlot()
    const id = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    const res = await executeApproval(sb, id, { userId: seed.ownerId })
    expect(res.ok).toBe(true)
    const rows = await appointmentsInSlot(sb, seed.shopId, slot)
    expect(rows).toHaveLength(1)
    expect(rows[0].pending_action_id).toBe(id)
  })

  it("repeated approval → already_decided, still exactly one appointment", async () => {
    const slot = freshSlot()
    const id = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    const first = await executeApproval(sb, id, { userId: seed.ownerId })
    const second = await executeApproval(sb, id, { userId: seed.ownerId })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second).toMatchObject({ status: "already_decided" })
    expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(1)
  })

  it("REPLAY of a successful booking (re-driven claim) → idempotent, no duplicate row", async () => {
    const slot = freshSlot()
    const id = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    const first = await executeApproval(sb, id, { userId: seed.ownerId })
    expect(first.ok).toBe(true)

    // Simulate the crash-replay window: the claim is re-driven even though
    // the appointment already persisted (the exact state a retried webhook /
    // interrupted process produces).
    await sb
      .from("pending_actions")
      .update({ status: "pending", decided_at: null, decided_by_user: null })
      .eq("id", id)
    const replay = await executeApproval(sb, id, { userId: seed.ownerId })
    expect(replay.ok).toBe(true)
    expect(replay).toMatchObject({ status: "executed" })
    // The durable unique + in-lock replay check kept it to ONE row.
    expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(1)
  })

  it("TOCTOU closed: two truly concurrent conflicting bookings → exactly one wins (repeated)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const slot = freshSlot()
      const idA = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
      const idB = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))

      // Two separate clients/connections, one Promise.all — genuinely
      // simultaneous requests, not sequential calls pretending.
      const [resA, resB] = await Promise.all([
        executeApproval(sb, idA, { userId: seed.ownerId }, { context: "automatic" }),
        executeApproval(sb2, idB, { userId: seed.ownerId }, { context: "automatic" }),
      ])

      const winners = [resA, resB].filter((r) => r.ok)
      const losers = [resA, resB].filter((r) => !r.ok)
      expect(winners, `round ${round}: exactly one winner`).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(1)

      // Loser: structured conflict result + coherent, retryable pending action.
      const loser = losers[0]
      if (loser.ok) throw new Error("unreachable")
      expect(loser.availability ?? loser.error).toBeTruthy()
      const loserId = resA === loser ? idA : idB
      const pendingState = await getPending(sb, loserId)
      expect(pendingState?.status).toBe("pending")
      // No override was recorded for the refused action (d43ce16 invariant).
      expect(await overrideDecisions(sb, loserId)).toBe(0)

      // Lock released: a free adjacent slot books immediately afterwards.
      const after = await stagePending(
        sb,
        seed.shopId,
        seed.ownerId,
        "book_appointment",
        bookingPayload(slot.end)
      )
      const resAfter = await executeApproval(sb, after, { userId: seed.ownerId })
      expect(resAfter.ok, `round ${round}: lock must be released`).toBe(true)
    }
  })

  it("two legitimate concurrent NON-overlapping bookings both succeed (no over-serialization)", async () => {
    const slotA = freshSlot()
    const slotB = freshSlot()
    const idA = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slotA.start))
    const idB = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slotB.start))
    const [resA, resB] = await Promise.all([
      executeApproval(sb, idA, { userId: seed.ownerId }),
      executeApproval(sb2, idB, { userId: seed.ownerId }),
    ])
    expect(resA.ok).toBe(true)
    expect(resB.ok).toBe(true)
  })

  it("capacity > 1 preserved: a documented override books over an existing appointment", async () => {
    const slot = freshSlot()
    const idFirst = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    const first = await executeApproval(sb, idFirst, { userId: seed.ownerId })
    expect(first.ok).toBe(true)
    const existing = (await appointmentsInSlot(sb, seed.shopId, slot))[0]

    const idSecond = await stagePending(
      sb,
      seed.shopId,
      seed.ownerId,
      "book_appointment",
      bookingPayload(slot.start, {
        conflict_override: {
          by: seed.ownerId,
          at: new Date().toISOString(),
          conflicts: [`appointment:${existing.id}`],
          reason: "Two techs on shift — double-stack on purpose",
        },
      })
    )
    const second = await executeApproval(sb, idSecond, { userId: seed.ownerId })
    expect(second.ok).toBe(true)
    expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(2)
    // The executed override left its audit row (d43ce16 protections intact).
    expect(await overrideDecisions(sb, idSecond)).toBe(1)
  })

  it("cross-tenant: concurrent bookings for the same wall-clock slot in two shops never block or leak", async () => {
    const slot = freshSlot()
    const idA = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    const idB = await stagePending(sb, seedB.shopId, seedB.ownerId, "book_appointment", bookingPayload(slot.start))
    const [resA, resB] = await Promise.all([
      executeApproval(sb, idA, { userId: seed.ownerId }),
      executeApproval(sb2, idB, { userId: seedB.ownerId }),
    ])
    expect(resA.ok).toBe(true)
    expect(resB.ok).toBe(true)
    expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(1)
    expect(await appointmentsInSlot(sb, seedB.shopId, slot)).toHaveLength(1)
  })

  it("RPC-level failure semantics: invalid range and a dangling idempotency key both refuse without persisting", async () => {
    const slot = freshSlot()
    const bad = await sb.rpc("write_appointment_serialized", {
      p_shop_id: seed.shopId,
      p_start: slot.end, // end before start
      p_end: slot.start,
      p_covered_ids: [],
      p_appointment_id: null,
      p_pending_action_id: null,
      p_lead_id: null,
      p_customer_id: null,
      p_duration_minutes: 120,
      p_service_name: "x",
      p_timezone: null,
      p_internal_note: null,
    })
    expect(bad.error?.message).toContain("invalid range")

    const dangling = await sb.rpc("write_appointment_serialized", {
      p_shop_id: seed.shopId,
      p_start: slot.start,
      p_end: slot.end,
      p_covered_ids: [],
      p_appointment_id: null,
      p_pending_action_id: "00000000-0000-4000-8000-000000000000", // no such action
      p_lead_id: null,
      p_customer_id: null,
      p_duration_minutes: 120,
      p_service_name: "x",
      p_timezone: null,
      p_internal_note: null,
    })
    expect(dangling.error).toBeTruthy() // FK violation → refused
    expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(0)
  })

  it("reschedule stays safe: serialized move refuses an occupied slot, lands on a free one with ends_at", async () => {
    const slotBusy = freshSlot()
    const slotHome = freshSlot()
    const idBusy = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slotBusy.start))
    const idHome = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slotHome.start))
    expect((await executeApproval(sb, idBusy, { userId: seed.ownerId })).ok).toBe(true)
    expect((await executeApproval(sb, idHome, { userId: seed.ownerId })).ok).toBe(true)
    const mover = (await appointmentsInSlot(sb, seed.shopId, slotHome))[0]

    // Onto the busy slot → refused, position unchanged.
    const idMoveBusy = await stagePending(sb, seed.shopId, seed.ownerId, "reschedule_appointment", {
      appointment_id: mover.id,
      current_scheduled_at: slotHome.start,
      service: "Full Detail",
      customer_name: "Atomic Avery",
      phone: "+15035550166",
      new_when: "moved",
      iso_new_start_time: slotBusy.start,
    })
    const refused = await executeApproval(sb, idMoveBusy, { userId: seed.ownerId })
    expect(refused.ok).toBe(false)
    expect(await appointmentsInSlot(sb, seed.shopId, slotHome)).toHaveLength(1)

    // Onto a free slot → moved, ends_at rides along.
    const slotFree = freshSlot()
    const idMoveFree = await stagePending(sb, seed.shopId, seed.ownerId, "reschedule_appointment", {
      appointment_id: mover.id,
      current_scheduled_at: slotHome.start,
      service: "Full Detail",
      customer_name: "Atomic Avery",
      phone: "+15035550166",
      new_when: "moved",
      iso_new_start_time: slotFree.start,
    })
    const moved = await executeApproval(sb, idMoveFree, { userId: seed.ownerId })
    expect(moved.ok).toBe(true)
    const { data } = await sb
      .from("appointments")
      .select("scheduled_at, ends_at")
      .eq("id", mover.id)
      .single()
    // Compare as instants — Postgres renders timestamptz with a +00:00 offset.
    expect(Date.parse(data?.scheduled_at ?? "")).toBe(Date.parse(slotFree.start))
    expect(Date.parse(data?.ends_at ?? "")).toBe(Date.parse(slotFree.end))
  })

  it("block-time stays safe: serialized insert refuses over a busy slot at the database", async () => {
    const slot = freshSlot()
    const id = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    expect((await executeApproval(sb, id, { userId: seed.ownerId })).ok).toBe(true)

    const blocked = await sb.rpc("write_appointment_serialized", {
      p_shop_id: seed.shopId,
      p_start: slot.start,
      p_end: slot.end,
      p_covered_ids: [],
      p_appointment_id: null,
      p_pending_action_id: null,
      p_lead_id: null,
      p_customer_id: null,
      p_duration_minutes: 120,
      p_service_name: "Blocked time",
      p_timezone: null,
      p_internal_note: "[block-time]",
    })
    expect(blocked.error).toBeNull()
    expect((blocked.data as { status?: string })?.status).toBe("conflict")
    expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(1)
  })

  it("external-calendar failure AFTER persistence: booking stands, sync failure recorded, no orphan events", async () => {
    const slot = freshSlot()
    mockedCreateEvent.mockRejectedValueOnce(new Error("Aurinko 500"))
    const id = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    const res = await executeApproval(sb, id, { userId: seed.ownerId })
    expect(res.ok).toBe(true)

    const rows = await appointmentsInSlot(sb, seed.shopId, slot)
    expect(rows).toHaveLength(1)
    const { data } = await sb
      .from("appointments")
      .select("aurinko_event_id")
      .eq("id", rows[0].id)
      .single()
    expect(data?.aurinko_event_id).toBeNull()
    const { data: pa } = await sb
      .from("pending_actions")
      .select("payload")
      .eq("id", id)
      .single()
    expect(
      (pa?.payload as { calendar_sync?: { status?: string } })?.calendar_sync?.status
    ).toBe("failed")
  })

  it("flag OFF → overlap NOT refused: pre-P0-004A double-booking preserved (enforcement gated, atomicity kept)", async () => {
    const prior = process.env.NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT
    process.env.NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT = "false"
    try {
      const slot = freshSlot()
      const idFirst = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
      expect((await executeApproval(sb, idFirst, { userId: seed.ownerId })).ok).toBe(true)

      // Second booking over the SAME slot, no override. With enforcement OFF
      // the serialized write must NOT refuse (behaves as before P0-004A) — the
      // deploy-with-flag-off release condition. Two rows coexist.
      const idSecond = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
      const second = await executeApproval(sb, idSecond, { userId: seed.ownerId })
      expect(second.ok).toBe(true)
      expect(await appointmentsInSlot(sb, seed.shopId, slot)).toHaveLength(2)
    } finally {
      if (prior === undefined) delete process.env.NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT
      else process.env.NEXT_PUBLIC_GRADIA_CONFLICT_ENFORCEMENT = prior
    }
  })

  it("no orphan external event: a refused booking never calls the provider", async () => {
    const slot = freshSlot()
    const idFirst = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    expect((await executeApproval(sb, idFirst, { userId: seed.ownerId })).ok).toBe(true)

    mockedCreateEvent.mockClear()
    const idSecond = await stagePending(sb, seed.shopId, seed.ownerId, "book_appointment", bookingPayload(slot.start))
    const refused = await executeApproval(sb, idSecond, { userId: seed.ownerId })
    expect(refused.ok).toBe(false)
    expect(mockedCreateEvent).not.toHaveBeenCalled()
  })
})
