import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { issueServiceProof } from "@/lib/service-purpose"
import { sendOutboundSms } from "@/lib/twilio"
import { recordUsage } from "@/lib/credits"
import { INTEGRATION, serviceClient, seedShop, stagePending, cleanup, type Seeded } from "./_db"

// Number-lifecycle audit: the owner disconnects texting while an approved
// text is mid-send. The provider is faked at sendOutboundSms; the moment it
// is called, the owner's disconnect lands (what disconnectSms writes).
const midSend = vi.hoisted(() => ({ disconnect: null as null | (() => Promise<void>) }))
vi.mock("@/lib/twilio", async (original) => ({
  ...(await original<typeof import("@/lib/twilio")>()),
  sendOutboundSms: vi.fn(async () => {
    await midSend.disconnect?.()
    return { messageSid: "SM" + randomUUID().replace(/-/g, ""), status: "queued" }
  }),
}))
vi.mock("@/lib/memory", async (original) => ({
  ...(await original<typeof import("@/lib/memory")>()),
  recordInteraction: vi.fn(async () => ({ ok: true as const, id: randomUUID(), embedded: false })),
}))
vi.mock("@/lib/credits", () => ({ recordUsage: vi.fn() }))
vi.mock("@/lib/pricing", async (original) => ({
  ...(await original<typeof import("@/lib/pricing")>()),
  getPricing: vi.fn(),
  priceUsage: () => ({ credits: 0, wholesale_cost: 0, retail_cost: 0 }),
}))

describe.skipIf(!INTEGRATION)("disconnect while an approval is mid-send", () => {
  let db: SupabaseClient, shop: Seeded, customer: string, appointment: string
  const NUMBER = "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
  const BYO_SID = "AC" + "3".repeat(32)

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    const { encryptSecret } = await import("@/lib/crypto")
    db = serviceClient(); shop = await seedShop(db)
    expect((await db.from("shops").update({
      quiet_hours_start: 0, quiet_hours_end: 0, twilio_phone_number: NUMBER,
      twilio_account_sid_enc: encryptSecret(BYO_SID), twilio_auth_token_enc: encryptSecret("synthetic-byo-token"),
    }).eq("id", shop.shopId)).error).toBeNull()
    // Attest as #93's owner function would; the guard allows the service role.
    expect((await db.from("shops").update({ byo_sms_verified: true }).eq("id", shop.shopId)).error).toBeNull()
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Synthetic mid-send", phone: "+15551112233", email: "midsend@example.test", do_not_contact: false }).select("id").single()
    expect(c.error).toBeNull(); customer = c.data!.id
    const a = await db.from("appointments").insert({ shop_id: shop.shopId, customer_id: customer, scheduled_at: "2032-01-01T12:00:00Z" }).select("id").single()
    expect(a.error).toBeNull(); appointment = a.data!.id
  })
  afterEach(() => { vi.clearAllMocks(); midSend.disconnect = null })
  afterAll(async () => { if (shop) await cleanup(db, shop) })

  async function stage() {
    const message = { shopId: shop.shopId, customerId: customer, channel: "sms" as const, destination: "+15551112233", body: "Your appointment is confirmed" }
    const proof = await issueServiceProof(db, message, { kind: "appointment", id: appointment })
    expect(proof).toBeTruthy()
    return stagePending(db, shop.shopId, shop.ownerId, "send_sms", { customer_id: customer, category: "transactional", service_proof: proof, body: message.body, to_phone: message.destination })
  }
  const execute = (id: string) => executeApproval(db, id, shop.shopId, { userId: shop.ownerId })

  it("the in-flight text goes out once from the number it was approved on; nothing after the disconnect sends", async () => {
    const id = await stage()
    midSend.disconnect = async () => {
      expect((await db.from("shops").update({ twilio_phone_number: null, twilio_account_sid_enc: null, twilio_auth_token_enc: null }).eq("id", shop.shopId)).error).toBeNull()
    }
    expect(await execute(id)).toMatchObject({ ok: true, status: "executed" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendOutboundSms).mock.calls[0][0]).toMatchObject({ from: NUMBER, creds: { accountSid: BYO_SID, source: "byo" } })
    expect(recordUsage).toHaveBeenCalledTimes(1) // metered once
    const after = (await db.from("shops").select("twilio_phone_number, byo_sms_verified").eq("id", shop.shopId).single()).data!
    expect(after).toEqual({ twilio_phone_number: null, byo_sms_verified: false }) // #93 clears the attestation with the number

    // Re-running the same approval doesn't send again, and a new one is refused.
    expect(await execute(id)).toMatchObject({ ok: true, status: "already_decided" })
    expect(await execute(await stage())).toMatchObject({ ok: false, error: expect.stringContaining("Connect SMS") })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
  })
})
