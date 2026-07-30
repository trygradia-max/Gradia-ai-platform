import { describe, it, expect, beforeAll, afterAll } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { checkAvailability } from "@/lib/availability"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"

/**
 * P0-003 conflict service against a real Postgres (the un-quarantined tier).
 * Proves what a mock can't: the actual shop-scoped range query returns the
 * seeded overlapping rows with the structured conflict payload — and that a
 * second shop's identical time range is invisible (tenant isolation under
 * the service-role client, where RLS does not backstop).
 */
describe.skipIf(!INTEGRATION)("availability conflict service [integration]", () => {
  let sb: SupabaseClient
  let shopA: Seeded
  let shopB: Seeded

  // Manual-acceptance shape (ticket §Manual acceptance 1): 10:00–12:00 and
  // 11:00–13:00 seeded; 11:30–12:30 must conflict with both.
  const DAY = "2026-08-12"
  const iso = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`

  const seededIds: { a: string[]; b: string[] } = { a: [], b: [] }

  async function seedAppointment(
    shopId: string,
    startIso: string,
    endIso: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> {
    const durationMinutes = Math.round(
      (Date.parse(endIso) - Date.parse(startIso)) / 60_000
    )
    const { data, error } = await sb
      .from("appointments")
      .insert({
        shop_id: shopId,
        scheduled_at: startIso,
        duration_minutes: durationMinutes,
        ends_at: endIso,
        service_name: "Full Detail",
        ...extra,
      })
      .select("id")
      .single()
    if (error || !data) throw new Error(`seed appointment: ${error?.message}`)
    return data.id as string
  }

  beforeAll(async () => {
    sb = serviceClient()
    shopA = await seedShop(sb)
    shopB = await seedShop(sb)
    seededIds.a.push(
      await seedAppointment(shopA.shopId, iso("10:00"), iso("12:00")),
      await seedAppointment(shopA.shopId, iso("11:00"), iso("13:00"))
    )
    // Shop B books the identical window — must never leak into shop A's answer.
    seededIds.b.push(
      await seedAppointment(shopB.shopId, iso("10:00"), iso("12:00"))
    )
  })
  afterAll(async () => {
    if (shopA) await cleanup(sb, shopA)
    if (shopB) await cleanup(sb, shopB)
  })

  it("two seeded overlapping appointments → conflict listing both, structured", async () => {
    const result = await checkAvailability(sb, shopA.shopId, {
      start: iso("11:30"),
      end: iso("12:30"),
    })
    expect(result.available).toBe(false)
    const appt = result.conflicts.filter((c) => c.source === "appointment")
    expect(appt.map((c) => c.id).sort()).toEqual([...seededIds.a].sort())
    for (const c of appt) {
      expect(c.severity).toBe("blocking")
      expect(c.start).toBeTruthy()
      expect(c.end).toBeTruthy()
      expect(c.label).toContain("Full Detail")
    }
    // No calendar connected on a seeded shop → explicit degradation, not silence.
    expect(result.calendar).toBe("unchecked")
    expect(result.calendarUncheckedReason).toBe("not_connected")
  })

  it("boundary touch is available: 13:00–14:00 against a 11:00–13:00 booking", async () => {
    const result = await checkAvailability(sb, shopA.shopId, {
      start: iso("13:00"),
      end: iso("14:00"),
    })
    expect(result.conflicts.filter((c) => c.source === "appointment")).toEqual([])
  })

  it("tenant isolation: shop B's check never sees shop A's rows", async () => {
    const result = await checkAvailability(sb, shopB.shopId, {
      start: iso("11:30"),
      end: iso("12:30"),
    })
    const appt = result.conflicts.filter((c) => c.source === "appointment")
    expect(appt.map((c) => c.id)).toEqual(seededIds.b)
    for (const c of appt) {
      expect(seededIds.a).not.toContain(c.id)
    }
  })

  it("reschedule: excluding one seeded row leaves only the other conflicting", async () => {
    const [first, second] = seededIds.a
    const result = await checkAvailability(sb, shopA.shopId, {
      start: iso("11:30"),
      end: iso("12:30"),
      excludeAppointmentId: first,
    })
    const appt = result.conflicts.filter((c) => c.source === "appointment")
    expect(appt.map((c) => c.id)).toEqual([second])
  })
})
