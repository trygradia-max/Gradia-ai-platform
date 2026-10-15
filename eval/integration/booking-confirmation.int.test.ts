import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { sendOutboundSms } from "@/lib/twilio"
import { draftBookingConfirmationSms } from "@/lib/sms-drafter"
import { INTEGRATION, serviceClient, seedShop, stagePending, cleanup, type Seeded } from "./_db"

/**
 * A booking stages exactly one confirmation SMS for owner approval, and a
 * re-driven booking (crash between the appointment write and staging) repairs
 * a missing one instead of losing it. Disposable stack only; the drafter,
 * calendar and SMS transport are faked, and nothing is sent.
 */

vi.mock("@/lib/aurinko", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/aurinko")>(),
  getAccessTokenForShop: vi.fn(async () => "int-test-token"),
  listCalendarEvents: vi.fn(async () => []),
  createCalendarEvent: vi.fn(async () => ({ id: `ev-int-${randomUUID()}`, subject: "x", start: null, end: null, location: null })),
}))
vi.mock("@/lib/sms-drafter", () => ({
  draftBookingConfirmationSms: vi.fn(async () => "Fictional Shop: you're booked. Reply here with any questions."),
}))
vi.mock("@/lib/twilio", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/twilio")>(),
  sendOutboundSms: vi.fn(async () => ({ messageSid: "synthetic-message", status: "queued" })),
}))
vi.mock("@/lib/crm-provider", () => ({ pushBookingToCrm: vi.fn(async () => undefined), pushLeadToCrm: vi.fn(async () => undefined) }))
vi.mock("@/lib/agent-events", () => ({ dispatchAgentEvent: vi.fn(async () => undefined) }))
vi.mock("@/lib/memory", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory")>(),
  recordInteraction: vi.fn(async () => ({ ok: true as const, id: randomUUID(), embedded: false })),
}))

let slotCounter = 0
const futureSlot = () => new Date(Date.parse("2033-04-04T17:00:00.000Z") + ++slotCounter * 72 * 60 * 60_000).toISOString()
const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const booking = (start: string, to = phone()) => ({
  customer_name: "Fictional Booker", phone: to, car_info: null, service: "Full Detail", iso_start_time: start,
  duration_minutes: 120, timezone: "UTC", email: null, pin_notes: null,
})

describe.skipIf(!INTEGRATION)("booking confirmation is staged exactly once per appointment", () => {
  let db: SupabaseClient, shop: Seeded
  beforeAll(async () => {
    db = serviceClient()
    shop = await seedShop(db)
    expect((await db.from("shops").update({ twilio_phone_number: "+15550003333", byo_sms_verified: true }).eq("id", shop.shopId)).error).toBeNull()
  })
  afterEach(() => vi.clearAllMocks())
  afterAll(async () => { if (shop) await cleanup(db, shop) })

  const approve = (id: string) => executeApproval(db, id, shop.shopId, { userId: shop.ownerId })
  const appointmentFor = async (actionId: string) =>
    (await db.from("appointments").select("id").eq("shop_id", shop.shopId).eq("pending_action_id", actionId).single()).data!.id as string
  const confirmations = async (appointmentId: string) =>
    (await db.from("pending_actions").select("id,status,payload").eq("shop_id", shop.shopId)
      .eq("payload->>source", "booking_confirmation").eq("payload->>appointment_id", appointmentId)).data ?? []
  /** What a replay sees: the claim was returned to pending after a crash. */
  const reDrive = async (id: string) =>
    expect((await db.from("pending_actions").update({ status: "pending", result_id: null, decided_at: null }).eq("id", id)).error).toBeNull()
  /** The durable state a crash leaves between the appointment write and the confirmation. */
  async function crashedAfterWrite(start: string) {
    const payload = booking(start)
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: payload.customer_name, phone: payload.phone }).select("id").single()
    expect(c.error).toBeNull()
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", payload)
    const write = await db.rpc("write_appointment_serialized", {
      p_shop_id: shop.shopId, p_start: start, p_end: new Date(Date.parse(start) + 120 * 60_000).toISOString(),
      p_pending_action_id: id, p_customer_id: c.data!.id, p_duration_minutes: 120, p_service_name: "Full Detail", p_timezone: "UTC",
    })
    expect(write.error).toBeNull()
    return { id, appointmentId: write.data.id as string, phone: payload.phone }
  }

  it("a booking stages one transactional confirmation for approval and sends nothing", async () => {
    const payload = booking(futureSlot())
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", payload)
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    const rows = await confirmations(await appointmentFor(id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "pending", payload: { category: "transactional", to_phone: payload.phone } })
    expect(sendOutboundSms).not.toHaveBeenCalled()
  })

  it("a second approval and a re-driven replay never stage a second confirmation", async () => {
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", booking(futureSlot()))
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    expect(await approve(id)).toMatchObject({ ok: true, status: "already_decided" })
    await reDrive(id)
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    expect(await confirmations(await appointmentFor(id))).toHaveLength(1)
  })

  it("a crash between the appointment write and staging is repaired on replay, once", async () => {
    const crashed = await crashedAfterWrite(futureSlot())
    expect(await confirmations(crashed.appointmentId)).toHaveLength(0)
    expect(await approve(crashed.id)).toMatchObject({ ok: true, status: "executed", resultId: crashed.appointmentId })
    const rows = await confirmations(crashed.appointmentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "pending", payload: { category: "transactional", to_phone: crashed.phone } })
    await reDrive(crashed.id)
    expect(await approve(crashed.id)).toMatchObject({ ok: true, status: "executed" })
    expect(await confirmations(crashed.appointmentId)).toHaveLength(1)
    expect(sendOutboundSms).not.toHaveBeenCalled()
  })

  it("a confirmation the owner rejected is not re-staged by a replay", async () => {
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", booking(futureSlot()))
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    const appointmentId = await appointmentFor(id)
    const [first] = await confirmations(appointmentId)
    expect((await db.from("pending_actions").update({ status: "rejected" }).eq("id", first.id)).error).toBeNull()
    await reDrive(id)
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    expect((await confirmations(appointmentId)).map(r => r.status)).toEqual(["rejected"])
  })

  it("a replay for an appointment that has already started stages no late confirmation", async () => {
    const crashed = await crashedAfterWrite(new Date(Date.now() - 60 * 60_000).toISOString())
    expect(await approve(crashed.id)).toMatchObject({ ok: true, status: "executed" })
    expect(await confirmations(crashed.appointmentId)).toHaveLength(0)
  })

  it("a drafter outage leaves the booking standing with no confirmation; the next replay stages it", async () => {
    vi.mocked(draftBookingConfirmationSms).mockRejectedValueOnce(new Error("Synthetic drafter outage"))
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", booking(futureSlot()))
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    const appointmentId = await appointmentFor(id)
    expect(await confirmations(appointmentId)).toHaveLength(0)
    await reDrive(id)
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed", resultId: appointmentId })
    expect(await confirmations(appointmentId)).toHaveLength(1)
  })

  it("an appointment rescheduled after the failed confirmation is confirmed for its current time", async () => {
    const crashed = await crashedAfterWrite(futureSlot())
    const moved = futureSlot()
    expect((await db.from("appointments").update({ scheduled_at: moved, ends_at: new Date(Date.parse(moved) + 90 * 60_000).toISOString(), duration_minutes: 90 }).eq("id", crashed.appointmentId)).error).toBeNull()
    expect(await approve(crashed.id)).toMatchObject({ ok: true, status: "executed" })
    const [row] = await confirmations(crashed.appointmentId)
    expect(Date.parse(row.payload.iso_start_time as string)).toBe(Date.parse(moved))
    expect(vi.mocked(draftBookingConfirmationSms)).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 90 }))
    expect(Date.parse(vi.mocked(draftBookingConfirmationSms).mock.calls[0][0].isoStartTime)).toBe(Date.parse(moved))
  })

  it("a closed appointment gets no repaired confirmation", async () => {
    const crashed = await crashedAfterWrite(futureSlot())
    expect((await db.from("appointments").update({ status: "closed" }).eq("id", crashed.appointmentId)).error).toBeNull()
    expect(await approve(crashed.id)).toMatchObject({ ok: true, status: "executed" })
    expect(await confirmations(crashed.appointmentId)).toHaveLength(0)
  })

  it("a customer whose phone changed is confirmed at the current number", async () => {
    const crashed = await crashedAfterWrite(futureSlot())
    const current = phone()
    const appt = (await db.from("appointments").select("customer_id").eq("id", crashed.appointmentId).single()).data!
    expect((await db.from("customers").update({ phone: current }).eq("id", appt.customer_id)).error).toBeNull()
    expect(await approve(crashed.id)).toMatchObject({ ok: true, status: "executed" })
    const [row] = await confirmations(crashed.appointmentId)
    expect(row.payload.to_phone).toBe(current)
  })

  it("an appointment moved while the repair is staging leaves no stale confirmation; the next replay confirms the new time", async () => {
    const crashed = await crashedAfterWrite(futureSlot())
    const moved = futureSlot()
    const racer = interleaved(db, "pending_actions", "insert", async () => {
      expect((await db.from("appointments").update({ scheduled_at: moved, ends_at: new Date(Date.parse(moved) + 120 * 60_000).toISOString() }).eq("id", crashed.appointmentId)).error).toBeNull()
    })
    expect(await executeApproval(racer, crashed.id, shop.shopId, { userId: shop.ownerId })).toMatchObject({ ok: true, status: "executed" })
    expect(await confirmations(crashed.appointmentId)).toHaveLength(0)
    await reDrive(crashed.id)
    expect(await approve(crashed.id)).toMatchObject({ ok: true, status: "executed" })
    const rows = await confirmations(crashed.appointmentId)
    expect(rows).toHaveLength(1)
    expect(Date.parse(rows[0].payload.iso_start_time as string)).toBe(Date.parse(moved))
  })
})

/**
 * A client whose first awaited `method` ("insert" or "update") on `table` runs
 * `competing` first: after this code's reads, before that write.
 */
function interleaved(client: SupabaseClient, table: string, method: "insert" | "update", competing: () => Promise<unknown>): SupabaseClient {
  let fired = false
  return new Proxy(client, {
    get(target, key) {
      if (key === "from") return (name: string) => {
        const builder = target.from(name)
        if (name !== table) return builder
        const original = (builder as unknown as Record<string, (...a: unknown[]) => unknown>)[method].bind(builder)
        ;(builder as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
          const filter = original(...args) as { then: (ok: unknown, bad?: unknown) => unknown }
          const then = filter.then.bind(filter)
          filter.then = (ok: unknown, bad?: unknown) => {
            if (fired) return then(ok, bad)
            fired = true
            return Promise.resolve().then(competing).then(() => then(ok, bad), bad as (e: unknown) => unknown)
          }
          return filter
        }
        return builder
      }
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
