import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, stagePending, cleanup, type Seeded } from "./_db"

// B7: a booking's length is decided from the menu at execution, not from the
// model or API caller that staged it. Disposable stack only; calendar, drafter
// and CRM are faked and nothing is sent.
vi.mock("@/lib/aurinko", async original => ({
  ...await original<typeof import("@/lib/aurinko")>(),
  getAccessTokenForShop: vi.fn(async () => "int-test-token"),
  listCalendarEvents: vi.fn(async () => []),
  createCalendarEvent: vi.fn(async () => ({ id: `ev-int-${randomUUID()}`, subject: "x", start: null, end: null, location: null })),
}))
vi.mock("@/lib/sms-drafter", () => ({ draftBookingConfirmationSms: vi.fn(async () => null) }))
vi.mock("@/lib/crm-provider", () => ({ pushBookingToCrm: vi.fn(async () => undefined), pushLeadToCrm: vi.fn(async () => undefined) }))
vi.mock("@/lib/agent-events", () => ({ dispatchAgentEvent: vi.fn(async () => undefined) }))
vi.mock("@/lib/memory", async original => ({ ...await original<typeof import("@/lib/memory")>(), recordInteraction: vi.fn(async () => ({ ok: true as const, id: randomUUID(), embedded: false })) }))
import { updatePendingProposal } from "@/app/actions/approvals"
let owner: SupabaseClient, shop: Seeded
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: shop.ownerId }), requireShop: async () => ({ id: shop.shopId }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => owner }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

let slot = 0
const nextSlot = () => new Date(Date.parse("2034-05-05T16:00:00.000Z") + ++slot * 72 * 3_600_000).toISOString()
const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const booking = (service: string | null, duration_minutes: number, extra: Record<string, unknown> = {}) => ({
  customer_name: "Fictional Booker", phone: phone(), car_info: null, service, iso_start_time: nextSlot(),
  duration_minutes, timezone: "UTC", email: null, pin_notes: null, ...extra,
})

describe.skipIf(!INTEGRATION_WITH_SESSION)("booking length is menu-grounded at execution", () => {
  let db: SupabaseClient
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password })          // menu: "Full Detail", 180 min
    owner = await ownerSessionClient(shop.email, password)
    const menu = await db.from("services").insert([
      { shop_id: shop.shopId, name: "Ceramic Coating 1 Year", price_cents: 90000, duration_minutes: 240 },
      { shop_id: shop.shopId, name: "Ceramic Coating 5 Year", price_cents: 150000, duration_minutes: 480 },
      { shop_id: shop.shopId, name: "Paint Correction", price_cents: 60000, duration_minutes: 180, duration_by_size: { sedan: 180, truck_suv: 300 } },
    ])
    expect(menu.error).toBeNull()
  })
  afterEach(() => vi.clearAllMocks())
  afterAll(async () => { if (shop) await cleanup(db, shop) })

  const approve = (id: string) => executeApproval(db, id, shop.shopId, { userId: shop.ownerId })
  const booked = async (id: string) => {
    const a = (await db.from("appointments").select("scheduled_at,ends_at,duration_minutes").eq("shop_id", shop.shopId).eq("pending_action_id", id).maybeSingle()).data
    return a ? { minutes: (Date.parse(a.ends_at) - Date.parse(a.scheduled_at)) / 60_000, column: a.duration_minutes } : null
  }
  const status = async (id: string) => (await db.from("pending_actions").select("status").eq("id", id).single()).data!.status

  // MCP proposals carry token provenance checked at claim; their input schema is
  // pinned below. The executor applies one rule whatever the source.
  it.each([
    ["voice", 30],
    ["owner_agent", 600],
  ])("a %s-staged booking is booked for the menu length, not the staged %i minutes", async (source, staged) => {
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", booking("full detail", staged, { source }))
    const r = await approve(id)
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, status: "executed" })
    expect(await booked(id)).toEqual({ minutes: 180, column: 180 })
  })

  it.each([
    ["Mystery foam party", "doesn't match a service"],
    ["ceramic coating", "matches more than one service"],
    ["Paint Correction", "depends on vehicle size"],
  ])("%s is held for the owner, with nothing booked", async (service, message) => {
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", booking(service, 90, { source: "voice" }))
    expect(await approve(id)).toMatchObject({ ok: false, error: expect.stringContaining(message) })
    expect(await booked(id)).toBeNull()
    expect(await status(id)).toBe("pending")
  })

  it("a size-dependent service uses the known vehicle size of the customer", async () => {
    const payload = booking("Paint Correction", 90, { source: "voice" })
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Truck Owner", phone: payload.phone }).select("id").single()
    expect(c.error).toBeNull()
    expect((await db.from("vehicles").insert({ shop_id: shop.shopId, customer_id: c.data!.id, make: "Fictional", size_class: "truck_suv" })).error).toBeNull()
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", payload)
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    expect(await booked(id)).toEqual({ minutes: 300, column: 300 })
  })

  it("the owner's own edit of a held card is their decision and is booked as set", async () => {
    const payload = booking("Mystery foam party", 90, { source: "voice" })
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", payload)
    expect(await approve(id)).toMatchObject({ ok: false })
    const edit = await updatePendingProposal(id, {
      type: "book_appointment", customer_name: payload.customer_name, phone: payload.phone, car_info: null,
      service: payload.service, iso_start_time: payload.iso_start_time, duration_minutes: 75, timezone: "UTC", pin_notes: null,
    })
    expect(edit).toMatchObject({ ok: true })
    expect(await approve(id)).toMatchObject({ ok: true, status: "executed" })
    expect(await booked(id)).toEqual({ minutes: 75, column: 75 })
  })

  it("a quote-origin booking keeps its server-computed menu length (regression)", async () => {
    const payload = booking("Full Detail + Ceramic Coating 1 Year", 420, { source: "quote_page", duration_source: "menu" })
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: payload.customer_name, phone: payload.phone }).select("id").single()
    expect(c.error).toBeNull()
    const q = await db.from("quotes").insert({
      shop_id: shop.shopId, customer_id: c.data!.id, status: "accepted",
      line_items: [{ service_id: shop.serviceId, name: "Full Detail", base_cents: 25000, price_cents: 25000 }],
      subtotal_cents: 25000, discount_cents: 0, total_cents: 25000, created_by: "owner",
    }).select("id").single()
    expect(q.error).toBeNull()
    const id = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", { ...payload, quote_id: q.data!.id })
    const r = await approve(id)
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, status: "executed" })
    expect(await booked(id)).toEqual({ minutes: 420, column: 420 })
  })

  it("MCP's proposal schema cannot carry an owner-length marker", async () => {
    const { mcpProposalSchemas } = await import("@/lib/mcp/proposal")
    const mcpProposalSchema = mcpProposalSchemas[2]
    const payload = { customer_id: randomUUID(), customer_name: "Fictional", phone: "+15555550123", email: null, car_info: null, service: "Wash", iso_start_time: nextSlot(), duration_minutes: 15, timezone: null, pin_notes: null }
    expect(mcpProposalSchema.safeParse({ type: "book_appointment", payload }).success).toBe(true)
    expect(mcpProposalSchema.safeParse({ type: "book_appointment", payload: { ...payload, duration_source: "owner" } }).success).toBe(false)
  })
})
