import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"
import { TwilioError } from "@/lib/twilio"

// Resumable A2P registration, against real Postgres. Twilio's TrustHub and
// Messaging steps are faked at their module boundary; nothing reaches Twilio.
const a2p = vi.hoisted(() => ({
  calls: [] as string[],
  fail: new Map<string, unknown>(),
  brand: "PENDING" as "PENDING" | "APPROVED" | "FAILED",
  campaign: "PENDING" as "PENDING" | "IN_PROGRESS" | "VERIFIED" | "FAILED" | "SUSPENDED",
  /** Campaigns that exist at the fake Twilio, per messaging service. */
  onService: new Map<string, { campaignSid: string; brandSid: string }[]>(),
}))
vi.mock("@/lib/twilio-a2p", () => {
  let n = 0
  const step = (name: string, result: () => Record<string, string>) => async () => {
    a2p.calls.push(name)
    const failure = a2p.fail.get(name)
    if (failure) { a2p.fail.delete(name); throw failure }
    return result()
  }
  const sid = (p: string) => `${p}${String(++n).padStart(32, "0")}`
  return {
    registerBusinessProfile: step("profile", () => ({ customerProfileSid: sid("BU") })),
    registerA2pTrustProduct: step("trust_product", () => ({ trustProductSid: sid("BU") })),
    registerSoleProprietorProfile: step("profile", () => ({ customerProfileSid: sid("BU"), trustProductSid: sid("BU") })),
    createBrand: step("brand", () => ({ brandSid: sid("BN") })),
    createSoleProprietorBrand: step("brand", () => ({ brandSid: sid("BN") })),
    createMessagingService: step("messaging_service", () => ({ messagingServiceSid: sid("MG") })),
    createCampaign: async (_c: unknown, input: { messagingServiceSid: string; brandSid: string }) => {
      const { campaignSid } = await step("campaign", () => ({ campaignSid: sid("QE") }))()
      a2p.onService.set(input.messagingServiceSid, [...(a2p.onService.get(input.messagingServiceSid) ?? []), { campaignSid, brandSid: input.brandSid }])
      return { campaignSid }
    },
    listCampaigns: async (_c: unknown, mg: string) => (a2p.onService.get(mg) ?? []).map((c) => ({ ...c, status: a2p.campaign })),
    updateCampaign: step("update_campaign", () => ({})),
    attachNumberToMessagingService: step("attach_number", () => ({})),
    getBrandStatus: async () => ({ status: a2p.brand, failureReason: a2p.brand === "FAILED" ? "Legal name does not match the EIN" : null }),
    getCampaignStatus: async () => ({ status: a2p.campaign, errors: a2p.campaign === "FAILED" ? "Sample messages missing opt-out" : null }),
    resendSoleProprietorOtp: async () => undefined,
  }
})

const business = (legal = "Fictional Detail LLC") => ({
  has_ein: true, legal_name: legal, ein: "12-3456789", business_type: "LLC", website_url: "https://example.test",
  address: { street: "1 Fictional Way", city: "Portland", region: "OR", postal_code: "97201" },
  contact: { first_name: "Fic", last_name: "Tional", email: "owner@example.test", phone: "+15555550100", job_position: "Owner" },
})

describe.skipIf(!INTEGRATION)("resumable SMS (A2P) registration", () => {
  let db: SupabaseClient
  let start: typeof import("@/lib/telephony-provider").startA2pRegistration
  let sync: typeof import("@/lib/telephony-provider").syncA2pStatus
  let encrypt: typeof import("@/lib/crypto").encryptSecret
  const shops: Seeded[] = []
  const origin = "https://gradia.test"

  async function numberedShop() {
    const s = await seedShop(db)
    shops.push(s)
    const patch = {
      twilio_subaccount_sid: "AC" + s.shopId.replace(/-/g, ""), twilio_subaccount_token_enc: encrypt("synthetic-sub-token"),
      gradia_number_e164: "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0"), gradia_number_sid: "PN" + "1".repeat(32), a2p_status: "unregistered",
    }
    expect((await db.from("shops").update(patch).eq("id", s.shopId)).error).toBeNull()
    return (await db.from("shops").select("*").eq("id", s.shopId).single()).data
  }
  const reg = async (shopId: string) => (await db.from("a2p_registrations").select("*").eq("shop_id", shopId).single()).data
  const shopStatus = async (shopId: string) => (await db.from("shops").select("a2p_status").eq("id", shopId).single()).data!.a2p_status
  const transient = () => new TwilioError(503, "Synthetic Twilio outage")
  const refused = (m: string) => new TwilioError(400, m)

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.TWILIO_PRIMARY_PROFILE_SID = "BU" + "9".repeat(32)
    ;({ startA2pRegistration: start, syncA2pStatus: sync } = await import("@/lib/telephony-provider"))
    ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
    db = serviceClient()
  })
  beforeEach(() => { a2p.calls.length = 0; a2p.fail.clear(); a2p.brand = "PENDING"; a2p.campaign = "PENDING"; a2p.onService.clear() })
  afterAll(async () => { for (const s of shops) await cleanup(db, s) })

  it("a temporary failure midway keeps finished steps; resubmitting the same details resumes without a second profile", async () => {
    const shop = await numberedShop()
    a2p.fail.set("trust_product", transient())
    expect(await start({ supabase: db, shop, business: business(), origin })).toMatchObject({ ok: false })
    const failed = await reg(shop.id)
    expect(failed).toMatchObject({ status: "draft", failed_step: "trust_product", retryable: true, trust_product_sid: null, attempts: 1 })
    expect(failed.customer_profile_sid).toMatch(/^BU/)
    expect(await shopStatus(shop.id)).toBe("unregistered")

    a2p.calls.length = 0
    expect(await start({ supabase: db, shop, business: business(), origin })).toEqual({ ok: true })
    expect(a2p.calls).toEqual(["trust_product", "brand"])
    const resumed = await reg(shop.id)
    expect(resumed).toMatchObject({ status: "brand_pending", customer_profile_sid: failed.customer_profile_sid, failed_step: null, retryable: null, failure_reason: null, attempts: 2 })
    expect(await shopStatus(shop.id)).toBe("pending")
  })

  it("details refused by Twilio need the owner's fix; changed details start a fresh chain", async () => {
    const shop = await numberedShop()
    a2p.fail.set("brand", refused("Brand registration: EIN does not match legal name"))
    expect(await start({ supabase: db, shop, business: business(), origin })).toEqual({ ok: false, error: "Brand registration: EIN does not match legal name" })
    const first = await reg(shop.id)
    expect(first).toMatchObject({ status: "draft", failed_step: "brand", retryable: false })
    a2p.calls.length = 0
    expect(await start({ supabase: db, shop, business: business("Fictional Detail Company LLC"), origin })).toEqual({ ok: true })
    expect(a2p.calls).toEqual(["profile", "trust_product", "brand"])
    expect((await reg(shop.id)).customer_profile_sid).not.toBe(first.customer_profile_sid)
  })

  it("a submission already with carriers, or approved, is refused with nothing created", async () => {
    const shop = await numberedShop()
    expect(await start({ supabase: db, shop, business: business(), origin })).toEqual({ ok: true })
    a2p.calls.length = 0
    expect(await start({ supabase: db, shop, business: business(), origin })).toMatchObject({ ok: false, error: expect.stringContaining("already with the carriers") })
    expect(a2p.calls).toEqual([])
    expect((await reg(shop.id)).attempts).toBe(1)
  })

  it("after brand approval the messaging service is created once, even when the campaign fails and is retried", async () => {
    const shop = await numberedShop()
    await start({ supabase: db, shop, business: business(), origin })
    a2p.brand = "APPROVED"
    a2p.fail.set("campaign", transient())
    a2p.calls.length = 0
    expect(await sync({ supabase: db, shop, origin })).toMatchObject({ status: "brand_pending", failureReason: expect.stringContaining("retried on the next status check") })
    const held = await reg(shop.id)
    expect(held).toMatchObject({ status: "brand_pending", failed_step: "campaign", retryable: true, campaign_sid: null })
    expect(held.messaging_service_sid).toMatch(/^MG/)
    expect(await sync({ supabase: db, shop, origin })).toEqual({ status: "campaign_pending", failureReason: null })
    expect(a2p.calls.filter(c => c === "messaging_service")).toHaveLength(1)
    expect(await reg(shop.id)).toMatchObject({ status: "campaign_pending", messaging_service_sid: held.messaging_service_sid, failed_step: null })
  })

  it("a lost attach result is retried and an already-attached number counts as done", async () => {
    const shop = await numberedShop()
    await start({ supabase: db, shop, business: business(), origin })
    a2p.brand = "APPROVED"
    await sync({ supabase: db, shop, origin })
    a2p.campaign = "VERIFIED"
    a2p.fail.set("attach_number", transient())
    expect((await sync({ supabase: db, shop, origin })).status).toBe("campaign_pending")
    expect(await reg(shop.id)).toMatchObject({ failed_step: "attach_number", retryable: true })
    expect(await shopStatus(shop.id)).toBe("pending")
    a2p.fail.set("attach_number", new TwilioError(400, "Phone number is already in the Messaging Service"))
    expect(await sync({ supabase: db, shop, origin })).toEqual({ status: "approved", failureReason: null })
    expect(await reg(shop.id)).toMatchObject({ status: "approved", failed_step: null, retryable: null })
    expect(await shopStatus(shop.id)).toBe("approved")
  })

  it("a rejected brand is recorded with its reason and resubmits as a fresh chain", async () => {
    const shop = await numberedShop()
    await start({ supabase: db, shop, business: business(), origin })
    const before = await reg(shop.id)
    a2p.brand = "FAILED"
    expect(await sync({ supabase: db, shop, origin })).toEqual({ status: "rejected", failureReason: "Legal name does not match the EIN" })
    expect(await reg(shop.id)).toMatchObject({ status: "rejected", failed_step: "brand", retryable: false })
    expect(await shopStatus(shop.id)).toBe("rejected")
    a2p.calls.length = 0
    expect(await start({ supabase: db, shop, business: business(), origin })).toEqual({ ok: true })
    expect(a2p.calls).toEqual(["profile", "trust_product", "brand"])
    expect((await reg(shop.id)).brand_sid).not.toBe(before.brand_sid)
  })

  it("a rejected campaign keeps the approved brand, messaging service and campaign; resubmitting edits that campaign instead of creating one", async () => {
    const shop = await numberedShop()
    await start({ supabase: db, shop, business: business(), origin })
    a2p.brand = "APPROVED"
    await sync({ supabase: db, shop, origin })
    const pending = await reg(shop.id)
    a2p.campaign = "FAILED"
    expect((await sync({ supabase: db, shop, origin })).status).toBe("rejected")
    expect(await reg(shop.id)).toMatchObject({ status: "rejected", failed_step: "campaign", retryable: false })
    a2p.calls.length = 0
    expect(await start({ supabase: db, shop, business: business(), origin })).toEqual({ ok: true })
    expect(a2p.calls).toEqual([])
    expect(await reg(shop.id)).toMatchObject({ status: "brand_pending", brand_sid: pending.brand_sid, campaign_sid: pending.campaign_sid, attempts: 2 })
    expect(await shopStatus(shop.id)).toBe("pending")
    expect((await sync({ supabase: db, shop, origin })).status).toBe("campaign_pending")
    expect(a2p.calls).toEqual(["update_campaign"])
    expect(await reg(shop.id)).toMatchObject({ messaging_service_sid: pending.messaging_service_sid, campaign_sid: pending.campaign_sid })
  })

  it("Twilio refusing the campaign edit is recorded, and no second campaign is created", async () => {
    const shop = await numberedShop()
    await start({ supabase: db, shop, business: business(), origin })
    a2p.brand = "APPROVED"
    await sync({ supabase: db, shop, origin })
    a2p.campaign = "FAILED"
    await sync({ supabase: db, shop, origin })
    await start({ supabase: db, shop, business: business(), origin })
    a2p.calls.length = 0
    a2p.fail.set("update_campaign", refused("Campaign edits are not enabled for this account"))
    expect(await sync({ supabase: db, shop, origin })).toEqual({ status: "brand_pending", failureReason: "Campaign edits are not enabled for this account" })
    expect(a2p.calls).toEqual(["update_campaign"])
    expect(await reg(shop.id)).toMatchObject({ status: "brand_pending", failed_step: "campaign", retryable: false })
    expect(await shopStatus(shop.id)).toBe("pending")
  })
})
