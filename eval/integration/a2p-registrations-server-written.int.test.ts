import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, cleanup, ownerSessionClient, seedShop, serviceClient, type Seeded } from "./_db"

// Security audit run-1 (NEEDS-VALIDATION): a signed-in owner could rewrite
// a2p_registrations (status, SIDs, claim, evidence, attempts) through PostgREST, reset an
// approved/suspended/pending row to draft, and so re-enter provider registration through
// trusted service code. The table is now owner read-only. Real Postgres on the disposable
// stack; Twilio is mocked at its module boundary and counted. Nothing leaves the machine.
const a2p = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock("@/lib/twilio-a2p", () => {
  let n = 0
  const sid = (p: string) => `${p}${String(++n).padStart(32, "0")}`
  const step = (name: string, result: () => Record<string, string>) => async () => { a2p.calls.push(name); return result() }
  return {
    registerBusinessProfile: step("profile", () => ({ customerProfileSid: sid("BU") })),
    registerA2pTrustProduct: step("trust_product", () => ({ trustProductSid: sid("BU") })),
    registerSoleProprietorProfile: step("profile", () => ({ customerProfileSid: sid("BU"), trustProductSid: sid("BU") })),
    createBrand: step("brand", () => ({ brandSid: sid("BN") })),
    createSoleProprietorBrand: step("brand", () => ({ brandSid: sid("BN") })),
    createMessagingService: step("messaging_service", () => ({ messagingServiceSid: sid("MG") })),
    createCampaign: step("campaign", () => ({ campaignSid: sid("QE") })),
    listCampaigns: async () => [],
    updateCampaign: step("update_campaign", () => ({})),
    listBrandRegistrations: async () => [],
    listMessagingServices: async () => [],
    attachNumberToMessagingService: step("attach_number", () => ({})),
    getBrandStatus: async () => ({ status: "PENDING", failureReason: null }),
    getCampaignStatus: async () => ({ status: "PENDING", errors: null }),
    resendSoleProprietorOtp: async () => undefined,
  }
})

const PASSWORD = "Synthetic-password-123!"
const business = (legal = "Fictional Detail LLC") => ({
  has_ein: true, legal_name: legal, ein: "12-3456789", business_type: "LLC", website_url: "https://example.test",
  address: { street: "1 Fictional Way", city: "Portland", region: "OR", postal_code: "97201" },
  contact: { first_name: "Fic", last_name: "Tional", email: "owner@example.test", phone: "+15555550100", job_position: "Owner" },
})
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString()

// Every column an owner might forge, with a forged value.
const FORGED: Record<string, unknown> = {
  status: "draft", business: { has_ein: true, legal_name: "Forged" },
  customer_profile_sid: "BUforged", trust_product_sid: "BUforged", brand_sid: "BNforged",
  messaging_service_sid: "MGforged", campaign_sid: "QEforged", failure_reason: "forged",
  failed_step: "brand", retryable: true, attempts: 0, last_attempt_at: iso(), claim_token: "00000000-0000-4000-8000-000000000001",
  claimed_until: iso(60_000), last_checked_at: iso(), last_verified_at: iso(), last_check_failed_at: iso(),
  last_check_failure_kind: "provider_error", next_check_at: iso(), check_failures: 0, shop_id: "00000000-0000-4000-8000-000000000002",
}

describe.skipIf(!INTEGRATION_WITH_SESSION)("a2p_registrations is server-written; owners may only read", () => {
  let db: SupabaseClient
  let a: Seeded, b: Seeded
  let ownerA: SupabaseClient, ownerB: SupabaseClient
  let start: typeof import("@/lib/telephony-provider").startA2pRegistration
  let encrypt: typeof import("@/lib/crypto").encryptSecret
  const origin = "https://gradia.test"

  const row = async (id = a.shopId) => (await db.from("a2p_registrations").select("*").eq("shop_id", id).single()).data as Record<string, unknown>
  const shopRow = async (s: Seeded) => {
    const patch = {
      twilio_subaccount_sid: "AC" + s.shopId.replace(/-/g, ""), twilio_subaccount_token_enc: encrypt("synthetic-sub-token"),
      gradia_number_e164: "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0"), gradia_number_sid: "PN" + "1".repeat(32), a2p_status: "unregistered",
    }
    expect((await db.from("shops").update(patch).eq("id", s.shopId)).error).toBeNull()
    return (await db.from("shops").select("*").eq("id", s.shopId).single()).data!
  }
  /** Server-written approved registration, as the pipeline leaves it. */
  const seedApproved = async (s: Seeded) => {
    await db.from("a2p_registrations").delete().eq("shop_id", s.shopId)
    expect((await db.from("a2p_registrations").insert({
      shop_id: s.shopId, status: "approved", business: business(), customer_profile_sid: "BU" + "1".repeat(32),
      trust_product_sid: "BU" + "2".repeat(32), brand_sid: "BN" + "3".repeat(32), messaging_service_sid: "MG" + "4".repeat(32),
      campaign_sid: "QE" + "5".repeat(32), attempts: 1, last_verified_at: iso(-1000),
    })).error).toBeNull()
    expect((await db.from("shops").update({ a2p_status: "approved", a2p_verified_at: iso(-1000) }).eq("id", s.shopId)).error).toBeNull()
  }
  const denied = (error: { code?: string; details?: string; message?: string } | null) => {
    expect(error).not.toBeNull()
    // Either layer is a refusal: no grant (42501 permission denied) or the guard (42501 server_written).
    expect(error?.code).toBe("42501")
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.TWILIO_PRIMARY_PROFILE_SID = "BU" + "9".repeat(32)
    ;({ startA2pRegistration: start } = await import("@/lib/telephony-provider"))
    ;({ encryptSecret: encrypt } = await import("@/lib/crypto"))
    db = serviceClient()
    a = await seedShop(db, { password: PASSWORD })
    b = await seedShop(db, { password: PASSWORD })
    ownerA = await ownerSessionClient(a.email, PASSWORD)
    ownerB = await ownerSessionClient(b.email, PASSWORD)
  })
  beforeEach(() => { a2p.calls.length = 0 })
  afterAll(async () => { for (const s of [a, b]) if (s) await cleanup(db, s) })

  describe.each(["approved", "suspended", "campaign_pending", "brand_pending"] as const)("owner cannot reset a %s registration", (state) => {
    it("every column write is refused and the row is unchanged, so no provider call can follow", async () => {
      const shop = await shopRow(a)
      await seedApproved(a)
      expect((await db.from("a2p_registrations").update({ status: state }).eq("shop_id", a.shopId)).error).toBeNull()
      const before = await row()
      for (const [col, value] of Object.entries(FORGED)) {
        const res = await ownerA.from("a2p_registrations").update({ [col]: value }).eq("shop_id", a.shopId)
        denied(res.error)
      }
      // The attack in one request: back to draft with every SID cleared.
      denied((await ownerA.from("a2p_registrations").update({
        status: "draft", customer_profile_sid: null, trust_product_sid: null, brand_sid: null, messaging_service_sid: null,
        campaign_sid: null, claim_token: null, claimed_until: null, failed_step: null, retryable: null,
      }).eq("shop_id", a.shopId)).error)
      expect(await row()).toEqual(before)
      // Trusted service code still refuses to start from the untouched state: nothing reaches Twilio.
      const result = await start({ supabase: db, shop: shop as never, business: business("Changed Legal Name LLC"), origin })
      expect(result.ok).toBe(false)
      expect(a2p.calls).toEqual([])
      expect(await row()).toEqual(before)
    })
  })

  it("owner cannot delete the row or insert a replacement (delete-then-insert reset)", async () => {
    await shopRow(a)
    await seedApproved(a)
    const before = await row()
    denied((await ownerA.from("a2p_registrations").delete().eq("shop_id", a.shopId)).error)
    denied((await ownerA.from("a2p_registrations").upsert({ shop_id: a.shopId, status: "draft", business: business() }, { onConflict: "shop_id" })).error)
    expect(await row()).toEqual(before)
    // INSERT for a shop with no row is refused too (placeholder rows are server-written).
    await db.from("a2p_registrations").delete().eq("shop_id", b.shopId)
    denied((await ownerB.from("a2p_registrations").insert({ shop_id: b.shopId, status: "draft", business: business() })).error)
    denied((await ownerB.from("a2p_registrations").insert({ shop_id: b.shopId, status: "approved", brand_sid: "BNforged" })).error)
    expect((await db.from("a2p_registrations").select("shop_id").eq("shop_id", b.shopId)).data).toEqual([])
  })

  it("tenant isolation: an owner reads only their own row and cannot touch another shop's", async () => {
    await seedApproved(a)
    await db.from("a2p_registrations").delete().eq("shop_id", b.shopId)
    expect((await db.from("a2p_registrations").insert({ shop_id: b.shopId, status: "draft", business: business() })).error).toBeNull()
    const own = await ownerA.from("a2p_registrations").select("shop_id, status").eq("shop_id", a.shopId)
    expect(own.error).toBeNull()
    expect(own.data).toEqual([{ shop_id: a.shopId, status: "approved" }])
    expect((await ownerA.from("a2p_registrations").select("shop_id").eq("shop_id", b.shopId)).data).toEqual([])
    const before = await row(b.shopId)
    denied((await ownerA.from("a2p_registrations").update({ status: "approved" }).eq("shop_id", b.shopId)).error)
    expect(await row(b.shopId)).toEqual(before)
  })

  it("service_role edits and the rejected → resubmit flow still work (negative control)", async () => {
    const shop = await shopRow(b)
    await db.from("a2p_registrations").delete().eq("shop_id", b.shopId)
    expect((await db.from("a2p_registrations").insert({
      shop_id: b.shopId, status: "rejected", business: business(), failed_step: "brand", retryable: false, failure_reason: "EIN mismatch", attempts: 1,
    })).error).toBeNull()
    expect((await db.from("a2p_registrations").update({ failure_reason: "service edit" }).eq("shop_id", b.shopId)).error).toBeNull()
    // The safe flow: server code resubmits a rejected registration under the lease.
    const result = await start({ supabase: db, shop: shop as never, business: business("Corrected Legal Name LLC"), origin })
    expect(result).toEqual({ ok: true })
    expect(a2p.calls).toEqual(["profile", "trust_product", "brand"])
    expect(await row(b.shopId)).toMatchObject({ status: "brand_pending", attempts: 2, claim_token: null })
  })

  it("owner cannot edit a rejected row's business details or failure fields to steer the resubmit", async () => {
    const shop = await shopRow(b)
    await db.from("a2p_registrations").delete().eq("shop_id", b.shopId)
    expect((await db.from("a2p_registrations").insert({
      shop_id: b.shopId, status: "rejected", business: business("Original LLC"), brand_sid: "BN" + "3".repeat(32),
      failed_step: "campaign", retryable: true, failure_reason: "vague samples", attempts: 1,
    })).error).toBeNull()
    const before = await row(b.shopId)
    denied((await ownerB.from("a2p_registrations").update({ business: business("Pre-edited LLC"), failed_step: "brand", brand_sid: null }).eq("shop_id", b.shopId)).error)
    denied((await ownerB.from("a2p_registrations").update({ status: "draft" }).eq("shop_id", b.shopId)).error)
    expect(await row(b.shopId)).toEqual(before)
    // Server code, not the owner, decides: changed details start a fresh chain from the rejected row.
    const result = await start({ supabase: db, shop: shop as never, business: business("Corrected LLC"), origin })
    expect(result).toEqual({ ok: true })
    expect(a2p.calls[0]).toBe("profile")
    expect(await row(b.shopId)).toMatchObject({ status: "brand_pending", attempts: 2, claim_token: null })
  })

  it("service_role writers still work under the guard: claim, checkpoint, finish, and the shop-gate write", async () => {
    await shopRow(a)
    await db.from("a2p_registrations").delete().eq("shop_id", a.shopId)
    expect((await db.from("a2p_registrations").insert({ shop_id: a.shopId, status: "brand_pending", business: business() })).error).toBeNull()
    const claim = await db.rpc("a2p_claim_registration", { p_shop_id: a.shopId, p_statuses: ["brand_pending"], p_lease_seconds: 60 })
    expect(claim.error).toBeNull()
    expect(typeof claim.data).toBe("string")
    const checkpoint = await db.from("a2p_registrations").update({ brand_sid: "BN" + "7".repeat(32) }).eq("shop_id", a.shopId).eq("claim_token", claim.data as string).select("shop_id")
    expect(checkpoint.error).toBeNull()
    expect(checkpoint.data).toHaveLength(1)
    const finish = await db.rpc("a2p_finish_registration", {
      p_shop_id: a.shopId, p_token: claim.data, p_status: "campaign_pending", p_shop_status: "pending", p_patch: {}, p_check: null, p_failure_kind: null,
    })
    expect(finish.error).toBeNull()
    expect(finish.data).toBe(true)
    expect(await row()).toMatchObject({ status: "campaign_pending", brand_sid: "BN" + "7".repeat(32), claim_token: null })
    expect((await db.from("shops").select("a2p_status").eq("id", a.shopId).single()).data).toEqual({ a2p_status: "pending" })
    // The browser roles cannot call either function.
    for (const client of [ownerA, ownerB]) {
      const c = await client.rpc("a2p_claim_registration", { p_shop_id: a.shopId, p_statuses: ["campaign_pending"], p_lease_seconds: 60 })
      expect(c.error?.code).toBe("42501")
    }
    expect((await row()).claim_token).toBeNull()
  })

  it("an owner deleting their own shop still cascades the registration row away (FK actions are not blocked)", async () => {
    const c = await seedShop(db, { password: PASSWORD })
    try {
      const owner = await ownerSessionClient(c.email, PASSWORD)
      expect((await db.from("a2p_registrations").insert({ shop_id: c.shopId, status: "approved", business: business() })).error).toBeNull()
      const del = await owner.from("shops").delete().eq("id", c.shopId).select("id")
      expect(del.error).toBeNull()
      expect(del.data).toHaveLength(1)
      expect((await db.from("a2p_registrations").select("id").eq("shop_id", c.shopId)).data).toEqual([])
    } finally {
      await cleanup(db, c)
    }
  })
})
