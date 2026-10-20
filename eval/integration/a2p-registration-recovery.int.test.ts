import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION, serviceClient, seedShop, cleanup, type Seeded } from "./_db"
import { TwilioError } from "@/lib/twilio"

// Regression tests for the October 19 Twilio review (findings R1, R2, R3 and
// R5 in docs/release/TWILIO_REVIEW_AND_PROVIDER_CHECKLIST.md). They began as
// the review's probes, which reproduced each finding; here they assert the
// fixed behaviour. Real Postgres on the disposable stack; Twilio is faked at
// the twilio-a2p module boundary, so nothing reaches Twilio.
type Campaign = "PENDING" | "IN_PROGRESS" | "VERIFIED" | "FAILED" | "SUSPENDED"
const a2p = vi.hoisted(() => ({
  calls: [] as string[],
  fail: new Map<string, unknown>(),
  /** Fail AFTER the provider created the resource: a response lost in transit. */
  lost: new Map<string, unknown>(),
  brand: "PENDING" as "PENDING" | "APPROVED" | "FAILED",
  campaign: "PENDING" as Campaign,
  delay: 0,
  onService: new Map<string, { campaignSid: string; brandSid: string }[]>(),
}))
vi.mock("@/lib/twilio-a2p", () => {
  let n = 0
  const sid = (p: string) => `${p}${String(++n).padStart(32, "0")}`
  const run = async <T,>(name: string, make: () => T): Promise<T> => {
    a2p.calls.push(name)
    if (a2p.delay) await new Promise((r) => setTimeout(r, a2p.delay))
    const failure = a2p.fail.get(name)
    if (failure) { a2p.fail.delete(name); throw failure }
    const result = make()
    const lost = a2p.lost.get(name)
    if (lost) { a2p.lost.delete(name); throw lost }
    return result
  }
  const step = (name: string, make: () => Record<string, string>) => () => run(name, make)
  return {
    registerBusinessProfile: step("profile", () => ({ customerProfileSid: sid("BU") })),
    registerA2pTrustProduct: step("trust_product", () => ({ trustProductSid: sid("BU") })),
    registerSoleProprietorProfile: step("profile", () => ({ customerProfileSid: sid("BU"), trustProductSid: sid("BU") })),
    createBrand: step("brand", () => ({ brandSid: sid("BN") })),
    createSoleProprietorBrand: step("brand", () => ({ brandSid: sid("BN") })),
    createMessagingService: step("messaging_service", () => ({ messagingServiceSid: sid("MG") })),
    createCampaign: (_c: unknown, input: { messagingServiceSid: string; brandSid: string }) =>
      run("campaign", () => {
        const campaignSid = sid("QE")
        a2p.onService.set(input.messagingServiceSid, [...(a2p.onService.get(input.messagingServiceSid) ?? []), { campaignSid, brandSid: input.brandSid }])
        return { campaignSid }
      }),
    listCampaigns: async (_c: unknown, mg: string) => (a2p.onService.get(mg) ?? []).map((c) => ({ ...c, status: a2p.campaign })),
    updateCampaign: step("update_campaign", () => ({})),
    attachNumberToMessagingService: step("attach_number", () => ({})),
    getBrandStatus: async () => ({ status: a2p.brand, failureReason: null }),
    getCampaignStatus: async () => ({ status: a2p.campaign, errors: null }),
    resendSoleProprietorOtp: async () => undefined,
  }
})
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

const business = () => ({
  has_ein: true, legal_name: "Fictional Detail LLC", ein: "12-3456789", business_type: "LLC", website_url: "https://example.test",
  address: { street: "1 Fictional Way", city: "Portland", region: "OR", postal_code: "97201" },
  contact: { first_name: "Fic", last_name: "Tional", email: "owner@example.test", phone: "+15555550100", job_position: "Owner" },
})

describe.skipIf(!INTEGRATION)("A2P registration recovery under concurrency and lost responses", () => {
  let db: SupabaseClient
  let provider: typeof import("@/lib/telephony-provider")
  let encrypt: typeof import("@/lib/crypto").encryptSecret
  const shops: Seeded[] = []
  const origin = "https://gradia.test"

  async function numberedShop() {
    const s = await seedShop(db); shops.push(s)
    expect((await db.from("shops").update({
      twilio_subaccount_sid: "AC" + s.shopId.replace(/-/g, ""), twilio_subaccount_token_enc: encrypt("synthetic-sub-token"),
      gradia_number_e164: "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0"), gradia_number_sid: "PN" + "1".repeat(32), a2p_status: "unregistered",
    }).eq("id", s.shopId)).error).toBeNull()
    return (await db.from("shops").select("*").eq("id", s.shopId).single()).data
  }
  const start = (shop: Parameters<typeof provider.startA2pRegistration>[0]["shop"]) => provider.startA2pRegistration({ supabase: db, shop, business: business(), origin })
  const sync = (shop: Parameters<typeof provider.syncA2pStatus>[0]["shop"]) => provider.syncA2pStatus({ supabase: db, shop, origin })
  const reg = async (id: string) => (await db.from("a2p_registrations").select("*").eq("shop_id", id).single()).data
  const shopRow = async (id: string) => (await db.from("shops").select("*").eq("id", id).single()).data
  const count = (name: string) => a2p.calls.filter((c) => c === name).length
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.TWILIO_PRIMARY_PROFILE_SID = "BU" + "9".repeat(32)
    process.env.GRADIA_DASHBOARD_URL = "https://gradia.test"
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL // the disposable stack (asserted by serviceClient)
    provider = await import("@/lib/telephony-provider")
    ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
    db = serviceClient()
  })
  beforeEach(() => {
    a2p.calls.length = 0; a2p.fail.clear(); a2p.lost.clear(); a2p.onService.clear()
    a2p.brand = "PENDING"; a2p.campaign = "PENDING"; a2p.delay = 0
  })
  afterAll(async () => { for (const s of shops) await cleanup(db, s) })

  it("R1: a double-submitted registration creates one customer profile and one brand", async () => {
    const shop = await numberedShop()
    a2p.delay = 50
    const results = await Promise.all([start(shop), start(shop)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: expect.stringMatching(/already in progress|already with the carriers/) })
    expect(count("profile")).toBe(1)
    expect(count("trust_product")).toBe(1)
    expect(count("brand")).toBe(1)
    expect(await reg(shop.id)).toMatchObject({ status: "brand_pending", attempts: 1, claim_token: null })
    expect((await shopRow(shop.id)).a2p_status).toBe("pending")
  })

  it("R2: two concurrent status checks after brand approval create one messaging service and one campaign", async () => {
    const shop = await numberedShop()
    expect((await start(shop)).ok).toBe(true)
    a2p.calls.length = 0; a2p.brand = "APPROVED"; a2p.delay = 50
    await Promise.all([sync(shop), sync(shop)])
    expect(count("messaging_service")).toBe(1)
    expect(count("campaign")).toBe(1)
    expect(await reg(shop.id)).toMatchObject({ status: "campaign_pending", claim_token: null })
  })

  it("R3: a campaign created at Twilio whose response was lost is adopted, not created again", async () => {
    const shop = await numberedShop()
    expect((await start(shop)).ok).toBe(true)
    a2p.calls.length = 0; a2p.brand = "APPROVED"
    a2p.lost.set("campaign", new TwilioError(503, "Synthetic lost response"))
    expect((await sync(shop)).status).toBe("brand_pending")
    expect(await reg(shop.id)).toMatchObject({ status: "brand_pending", campaign_sid: null, failed_step: "campaign", retryable: true })
    expect(await sync(shop)).toEqual({ status: "campaign_pending", failureReason: null })
    expect(count("campaign")).toBe(1)
    expect(count("messaging_service")).toBe(1)
    const row = await reg(shop.id)
    expect(row.campaign_sid).toBe(a2p.onService.get(row.messaging_service_sid)![0].campaignSid)
  })

  it("R5: a rejected campaign is edited and resubmitted in place; no second campaign is created", async () => {
    const shop = await numberedShop()
    expect((await start(shop)).ok).toBe(true)
    a2p.brand = "APPROVED"
    await sync(shop)
    const first = await reg(shop.id)
    a2p.campaign = "FAILED"
    expect((await sync(shop)).status).toBe("rejected")
    expect(await start(shop)).toEqual({ ok: true })
    a2p.calls.length = 0
    expect((await sync(shop)).status).toBe("campaign_pending")
    expect(a2p.calls).toEqual(["update_campaign"])
    expect((await reg(shop.id)).campaign_sid).toBe(first.campaign_sid)
    expect(a2p.onService.get(first.messaging_service_sid)).toHaveLength(1)
  })

  it("R1, R2: the claim is exclusive, and only its holder can change status and the shop gate", async () => {
    const shop = await numberedShop()
    expect((await start(shop)).ok).toBe(true)
    const claim = (statuses: string[]) => db.rpc("a2p_claim_registration", { p_shop_id: shop.id, p_statuses: statuses, p_lease_seconds: 60 })
    const finish = (token: string, status: string, shopStatus: string) =>
      db.rpc("a2p_finish_registration", { p_shop_id: shop.id, p_token: token, p_status: status, p_shop_status: shopStatus, p_patch: {} })

    expect((await claim(["draft"])).data).toBeNull() // wrong status
    const held = (await claim(["brand_pending"])).data as string
    expect(held).toMatch(/^[0-9a-f-]{36}$/)
    expect((await claim(["brand_pending"])).data).toBeNull() // already held
    expect(await sync(shop)).toEqual({ status: "brand_pending", failureReason: null }) // a check while held calls nothing
    expect(a2p.calls).toEqual(["profile", "trust_product", "brand"])

    expect((await finish("00000000-0000-4000-8000-000000000000", "approved", "approved")).data).toBe(false)
    expect((await reg(shop.id)).status).toBe("brand_pending")
    expect((await shopRow(shop.id)).a2p_status).toBe("pending")

    expect((await finish(held, "campaign_pending", "pending")).data).toBe(true)
    expect(await reg(shop.id)).toMatchObject({ status: "campaign_pending", claim_token: null, claimed_until: null })
    expect((await claim(["campaign_pending"])).data).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("R1, R2: the claim and finish functions are server-only", async () => {
    const anon = (await import("@supabase/supabase-js")).createClient(process.env.SUPABASE_TEST_URL!, process.env.SUPABASE_TEST_ANON_KEY!)
    const shop = await numberedShop()
    const { error } = await anon.rpc("a2p_claim_registration", { p_shop_id: shop.id, p_statuses: ["draft"], p_lease_seconds: 60 })
    expect(error).not.toBeNull()
  })

  // The review's fifth probe (a late 'sent' delivery callback overwriting
  // 'delivered') is finding I5, fixed separately from registration recovery.
  it.todo("I5: delivery status never moves backwards (separate fix)")
})
