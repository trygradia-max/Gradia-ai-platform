import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { sendOutboundSms } from "@/lib/twilio"
import { getAccessTokenForShop, sendEmailMessage } from "@/lib/aurinko"
import { inboundSmsIntakeInput, recordLeadIntake } from "@/lib/lead-intake"
import { proposeNextQualificationQuestion, qualificationSchema } from "@/lib/lead-qualification"
import { readMessageDeliveryReview } from "@/lib/message-delivery-review"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, cleanup, type Seeded } from "./_db"

// B6: a queued qualification question through to delivery evidence, on SMS and
// email, with the REAL interaction history (only embeddings are disabled).
// Disposable stack only; both transports are faked and nothing leaves the machine.
vi.mock("@/lib/telephony-provider", async original => ({ ...await original<typeof import("@/lib/telephony-provider")>(), smsGateForShop: () => ({ allowed: true }) }))
vi.mock("@/lib/twilio", async original => ({ ...await original<typeof import("@/lib/twilio")>(), sendOutboundSms: vi.fn(async () => ({ messageSid: "SMsynthetic" + randomUUID().slice(0, 8), status: "queued" })) }))
vi.mock("@/lib/aurinko", async original => ({ ...await original<typeof import("@/lib/aurinko")>(), getAccessTokenForShop: vi.fn(async () => "synthetic-token"), sendEmailMessage: vi.fn(async () => ({ id: "synthetic-email-" + randomUUID().slice(0, 8) })) }))
vi.mock("@/lib/embeddings", () => ({
  EMBEDDING_MODEL: "test-disabled",
  embedText: async () => { throw new Error("embeddings disabled in integration test") },
  embedTexts: async () => { throw new Error("embeddings disabled in integration test") },
}))
vi.mock("@/lib/credits", () => ({ recordUsage: vi.fn() }))
vi.mock("@/lib/pricing", async original => ({ ...await original<typeof import("@/lib/pricing")>(), getPricing: vi.fn(), priceUsage: () => ({ credits: 0, wholesale_cost: 0, retail_cost: 0 }) }))
import { stageQualificationQuestion } from "@/app/actions/lead-qualification"
import { reviewCommunicationPurpose } from "@/app/actions/approvals"
let owner: SupabaseClient, shop: Seeded
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: shop.ownerId }), requireShop: async () => ({ id: shop.shopId }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => owner }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const ACCOUNT = 987654
const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")

describe.skipIf(!INTEGRATION_WITH_SESSION)("qualification question delivery evidence (SMS and email)", () => {
  let db: SupabaseClient
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password)
    expect((await db.from("shops").update({
      twilio_phone_number: "+15550006666", byo_sms_verified: true, quiet_hours_start: 0, quiet_hours_end: 0,
      aurinko_account_id: ACCOUNT, aurinko_access_token_enc: "synthetic-encrypted-token",
    }).eq("id", shop.shopId)).error).toBeNull()
  })
  afterEach(() => vi.clearAllMocks())
  afterAll(async () => { if (shop) await cleanup(db, shop) })

  /** A linked lead with one inbound message on `channel`, as after the customer wrote in. */
  async function lead(channel: "sms" | "email") {
    const address = channel === "sms" ? phone() : `${randomUUID()}@example.test`
    const intake = channel === "sms"
      ? await recordLeadIntake(db, inboundSmsIntakeInput({ shopId: shop.shopId, messageSid: "SM" + randomUUID().replace(/-/g, ""), from: address, body: "Fictional coating question", receivedAt: new Date().toISOString() }))
      : await recordLeadIntake(db, { shopId: shop.shopId, channel: "synthetic", provider: "synthetic", providerEventId: randomUUID(), threadKey: randomUUID(), receivedAt: new Date().toISOString(), payload: { email: address, message: "Fictional coating question" } })
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Lead", do_not_contact: false, ...(channel === "sms" ? { phone: address } : { email: address }) }).select("id,name,phone,email,updated_at").single()
    expect(c.error).toBeNull()
    expect((await owner.rpc("link_intake_customer", { p_shop: shop.shopId, p_workflow: intake.workflowId, p_revision: intake.revision, p_customer: c.data!.id, p_snapshot: c.data, p_command: randomUUID() })).error).toBeNull()
    const messageId = "fictional-" + randomUUID()
    const inbound = await db.from("interactions").insert({
      shop_id: shop.shopId, customer_id: c.data!.id, channel, role: "customer", content: "Fictional coating question",
      metadata: { direction: "inbound", ...(channel === "sms" ? { from_phone: address } : { from_email: address, aurinko_message_id: messageId }) },
    }).select("id").single()
    expect(inbound.error).toBeNull()
    if (channel === "email") expect((await db.from("email_reply_evidence").insert({ shop_id: shop.shopId, interaction_id: inbound.data!.id, account_id: ACCOUNT, message_id: messageId })).error).toBeNull()
    return { workflowId: intake.workflowId, customerId: c.data!.id as string, address, latest: inbound.data!.id as string, messageId, channel }
  }
  type Lead = Awaited<ReturnType<typeof lead>>

  async function reviewed(l: Lead) {
    const r = await owner.rpc("read_lead_qualification", { p_shop: shop.shopId, p_workflow: l.workflowId })
    expect(r.error).toBeNull()
    const p = proposeNextQualificationQuestion(qualificationSchema.parse(r.data))
    if (p.kind !== "question") throw new Error(`expected a question, got ${p.kind}`)
    return {
      shopId: shop.shopId, workflowId: l.workflowId, commandId: randomUUID(), basis: p.basis, target: p.target, questionId: p.question_id,
      channel: l.channel, conversation: { latestId: l.latest, revision: 0 },
      message: { body: p.text, subject: l.channel === "email" ? "A quick question about your request" : "", destination: l.address },
    }
  }
  /** Queue the proposed question and attach the owner's reply-purpose proof. */
  async function queuedAndReviewed(l: Lead) {
    const input = await reviewed(l)
    expect(await stageQualificationQuestion(input)).toMatchObject({ ok: true, status: "queued", actionId: input.commandId })
    expect(await reviewCommunicationPurpose(input.commandId, "reply")).toMatchObject({ ok: true })
    return input
  }
  const execute = (id: string, client: SupabaseClient = owner) => executeApproval(client, id, shop.shopId, { userId: shop.ownerId })
  const outbound = async (actionId: string) =>
    (await db.from("interactions").select("id,customer_id,channel,role,content,metadata").eq("shop_id", shop.shopId).eq("metadata->>pending_action_id", actionId)).data ?? []

  for (const channel of ["sms", "email"] as const) {
    const transport = channel === "sms" ? sendOutboundSms : sendEmailMessage

    it(`${channel}: one send under concurrent and exact retries, recorded once in the customer's history`, async () => {
      const l = await lead(channel), q = await queuedAndReviewed(l)
      expect(await outbound(q.commandId)).toEqual([])
      const results = await Promise.all([execute(q.commandId), execute(q.commandId, serviceClient())])
      expect(results.filter(r => r.ok && r.status === "executed"), JSON.stringify(results)).toHaveLength(1)
      expect(await execute(q.commandId)).toMatchObject({ ok: true, status: "already_decided" })
      expect(await stageQualificationQuestion(q)).toMatchObject({ ok: true, status: "already_queued", actionId: q.commandId })
      expect(transport).toHaveBeenCalledTimes(1)
      if (channel === "email") expect(sendEmailMessage).toHaveBeenCalledWith("synthetic-token", expect.objectContaining({ to: l.address, replyToMessageId: l.messageId }))

      const history = await outbound(q.commandId)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ customer_id: l.customerId, channel, role: "gradia", metadata: { direction: "outbound", pending_action_id: q.commandId } })
      expect(history[0].content).toContain(q.message.body)
      const action = (await db.from("pending_actions").select("status,result_id").eq("id", q.commandId).single()).data!
      expect(action).toEqual({ status: "approved", result_id: history[0].id })
      // Provider acceptance only. Gradia has no delivery receipt here and claims none.
      expect(await readMessageDeliveryReview(owner, shop.shopId, q.commandId)).toMatchObject({ state: "provider_accepted" })
    })

    it(`${channel}: an unknown provider outcome is held, never resent, and leaves no sent record`, async () => {
      const l = await lead(channel), q = await queuedAndReviewed(l)
      vi.mocked(transport).mockRejectedValueOnce(new Error("Synthetic timeout: outcome unknown"))
      expect(await execute(q.commandId)).toMatchObject({ ok: false })
      expect(await readMessageDeliveryReview(owner, shop.shopId, q.commandId)).toMatchObject({ state: "claimed" })
      expect(await execute(q.commandId)).toMatchObject({ ok: false })
      expect(await execute(q.commandId, serviceClient())).toMatchObject({ ok: false })
      expect(transport).toHaveBeenCalledTimes(1)
      expect(await outbound(q.commandId)).toEqual([])
      expect(await stageQualificationQuestion(await reviewed(l))).toEqual({ ok: false, code: "question_pending" })
    })

    it(`${channel}: suppression or do-not-contact after queueing holds it with zero external effects`, async () => {
      for (const block of ["suppressed", "dnc"] as const) {
        const l = await lead(channel), q = await queuedAndReviewed(l)
        if (block === "suppressed") expect((await db.from("customer_channel_permissions").insert({ shop_id: shop.shopId, customer_id: l.customerId, channel, destination: l.address, suppressed_at: new Date().toISOString(), suppression_source: "synthetic" })).error).toBeNull()
        else expect((await db.from("customers").update({ do_not_contact: true }).eq("id", l.customerId)).error).toBeNull()
        expect(await execute(q.commandId), block).toMatchObject({ ok: false })
        expect((await db.from("pending_actions").select("status,result_id").eq("id", q.commandId).single()).data).toEqual({ status: "pending", result_id: null })
        expect(await outbound(q.commandId)).toEqual([])
        expect(await readMessageDeliveryReview(owner, shop.shopId, q.commandId)).toEqual({ state: "unspent" })
      }
      expect(transport).not.toHaveBeenCalled()
      // A held email never refreshes the mailbox token.
      if (channel === "email") expect(getAccessTokenForShop).not.toHaveBeenCalled()
    })
  }

  it("sms: a STOP received after queueing holds it with zero external effects", async () => {
    const l = await lead("sms"), q = await queuedAndReviewed(l)
    expect((await db.from("customers").update({ sms_opted_out_at: new Date().toISOString() }).eq("id", l.customerId)).error).toBeNull()
    expect(await execute(q.commandId)).toMatchObject({ ok: false })
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(await outbound(q.commandId)).toEqual([])
  })
})

