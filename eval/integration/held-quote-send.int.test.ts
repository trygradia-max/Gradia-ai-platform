import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { sendOutboundSms } from "@/lib/twilio"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, cleanup, type Seeded } from "./_db"

// A quote send the SMS gate held, approved later from Approvals. Disposable
// stack only; the SMS transport is faked and nothing leaves the machine.
vi.mock("@/lib/twilio", async original => ({ ...await original<typeof import("@/lib/twilio")>(), sendOutboundSms: vi.fn(async () => ({ messageSid: "synthetic-message", status: "queued" })) }))
vi.mock("@/lib/memory", async original => ({ ...await original<typeof import("@/lib/memory")>(), recordInteraction: vi.fn(async () => ({ ok: true as const, id: randomUUID(), embedded: false })) }))
vi.mock("@/lib/credits", () => ({ recordUsage: vi.fn() }))
vi.mock("@/lib/pricing", async original => ({ ...await original<typeof import("@/lib/pricing")>(), getPricing: vi.fn(), priceUsage: () => ({ credits: 0, wholesale_cost: 0, retail_cost: 0 }) }))
import { sendQuote } from "@/app/actions/quotes"
let owner: SupabaseClient, shop: Seeded
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: shop.ownerId }), requireShop: async () => ({ id: shop.shopId, name: "Fictional Detail Co" }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => owner }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }) }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/service", async () => ({ createServiceClient: (await import("./_db")).serviceClient }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetInSeconds: 60 })) }))
import { respondToQuote } from "@/app/actions/quote-response"

const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")

describe.skipIf(!INTEGRATION_WITH_SESSION)("a held quote send approved later", () => {
  let db: SupabaseClient, manager: SupabaseClient, other: Seeded
  const verified = (value: boolean) => db.from("shops").update({ byo_sms_verified: value }).eq("id", shop.shopId)

  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); other = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); manager = await ownerSessionClient(other.email, password)
    expect((await db.from("shops").update({ twilio_phone_number: "+15550004444", quiet_hours_start: 0, quiet_hours_end: 0 }).eq("id", shop.shopId)).error).toBeNull()
    const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: other.email, p_name: "Fictional Manager", p_role: "manager", p_capabilities: ["crm.read", "approvals.messages"] })
    expect(invite.error).toBeNull()
    expect((await manager.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
  })
  afterEach(() => vi.clearAllMocks())
  afterAll(async () => { for (const s of [shop, other]) if (s) await cleanup(db, s) })

  /** An owner-drafted quote whose send the SMS gate holds (unverified BYO number). */
  async function heldQuote(leadStage = "needs_quote") {
    expect((await verified(false)).error).toBeNull()
    const to = phone()
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Quote Lead", phone: to, do_not_contact: false }).select("id").single()
    expect(c.error).toBeNull()
    const lead = await db.from("leads").insert({ shop_id: shop.shopId, customer_id: c.data!.id, customer_name: "Fictional Quote Lead", phone: to, status: "quoted", stage: leadStage }).select("id").single()
    expect(lead.error).toBeNull()
    const q = await db.from("quotes").insert({
      shop_id: shop.shopId, customer_id: c.data!.id, lead_id: lead.data!.id, status: "draft",
      line_items: [{ service_id: shop.serviceId, name: "Full Detail", base_cents: 25000, price_cents: 25000 }],
      subtotal_cents: 25000, discount_cents: 0, total_cents: 25000, created_by: "owner",
    }).select("id").single()
    expect(q.error).toBeNull()
    const held = await sendQuote(q.data!.id, "sms")
    expect(held).toMatchObject({ ok: false, held: true })
    const pending = await db.from("pending_actions").select("id,status,payload").eq("shop_id", shop.shopId).eq("payload->>quote_id", q.data!.id).single()
    expect(pending.error).toBeNull()
    expect(pending.data).toMatchObject({ status: "pending", payload: { category: "transactional", to_phone: to } })
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect((await verified(true)).error).toBeNull()
    return { quoteId: q.data!.id as string, leadId: lead.data!.id as string, actionId: pending.data!.id as string }
  }
  const quote = async (id: string) => (await db.from("quotes").select("status,sent_via,sent_at,public_token").eq("id", id).single()).data!
  const leadStage = async (id: string) => (await db.from("leads").select("stage").eq("id", id).single()).data!.stage
  const reviewHash = async (id: string) => {
    const page = await manager.rpc("list_delegated_message_approvals", { p_shop: shop.shopId, p_offset: 0 })
    expect(page.error).toBeNull()
    return page.data.items.find((x: { action_id: string }) => x.action_id === id)?.review_hash as string
  }

  it("owner approval later: the quote is sent once and recorded as sent", async () => {
    const h = await heldQuote()
    expect(await executeApproval(owner, h.actionId, shop.shopId, { userId: shop.ownerId })).toMatchObject({ ok: true, status: "executed" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await quote(h.quoteId)).toMatchObject({ status: "sent", sent_via: "sms", sent_at: expect.any(String) })
    expect(await leadStage(h.leadId)).toBe("quote_sent")
    // The customer's link now works: a draft quote would refuse any response.
    expect(await respondToQuote((await quote(h.quoteId)).public_token as string, "decline")).toMatchObject({ ok: true, status: "declined" })
  })

  it("delegated manager approval sends the owner's unchanged quote text once and records it the same way", async () => {
    const h = await heldQuote()
    const hash = await reviewHash(h.actionId)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // The manager cannot change the price text or recipient: the review hash binds the payload.
    const edited = await manager.from("pending_actions").update({ payload: { to_phone: phone(), body: "Edited price", category: "transactional" } }).eq("id", h.actionId).select("id")
    expect(edited.data ?? []).toEqual([])
    const result = await executeApproval(manager, h.actionId, shop.shopId, { userId: other.ownerId }, { delegated: { expectedReview: hash, executionClient: serviceClient() } })
    expect(result).toMatchObject({ ok: true, status: "executed" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await quote(h.quoteId)).toMatchObject({ status: "sent", sent_via: "sms" })
  })

  it("the owner's direct send (not held) still marks the quote sent exactly once", async () => {
    expect((await verified(true)).error).toBeNull()
    const to = phone()
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Direct Lead", phone: to, do_not_contact: false }).select("id").single()
    const lead = await db.from("leads").insert({ shop_id: shop.shopId, customer_id: c.data!.id, customer_name: "Fictional Direct Lead", phone: to, status: "quoted", stage: "needs_quote" }).select("id").single()
    const q = await db.from("quotes").insert({
      shop_id: shop.shopId, customer_id: c.data!.id, lead_id: lead.data!.id, status: "draft",
      line_items: [{ service_id: shop.serviceId, name: "Full Detail", base_cents: 25000, price_cents: 25000 }],
      subtotal_cents: 25000, discount_cents: 0, total_cents: 25000, created_by: "owner",
    }).select("id").single()
    expect(q.error).toBeNull()
    expect(await sendQuote(q.data!.id, "sms")).toEqual({ ok: true, via: "sms" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await quote(q.data!.id)).toMatchObject({ status: "sent", sent_via: "sms" })
    expect(await leadStage(lead.data!.id)).toBe("quote_sent")
  })

  it("a later quote send never moves a lead backwards from booked", async () => {
    const h = await heldQuote("booked")
    expect(await executeApproval(owner, h.actionId, shop.shopId, { userId: shop.ownerId })).toMatchObject({ ok: true, status: "executed" })
    expect(await leadStage(h.leadId)).toBe("booked")
  })
})
