import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { sendOutboundSms } from "@/lib/twilio"
import { getAccessTokenForShop, sendEmailMessage } from "@/lib/aurinko"
import { recordLeadIntake } from "@/lib/lead-intake"
import { proposeNextQualificationQuestion, qualificationSchema, unknownQualificationFields } from "@/lib/lead-qualification"
import { readMessageDeliveryReview } from "@/lib/message-delivery-review"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"

// A queued qualification question whose record moved on is held at send, with
// zero external effects. Disposable stack only; transports are faked.
vi.mock("@/lib/telephony-provider", async original => ({ ...await original<typeof import("@/lib/telephony-provider")>(), smsGateForShop: () => ({ allowed: true }) }))
vi.mock("@/lib/twilio", async original => ({ ...await original<typeof import("@/lib/twilio")>(), sendOutboundSms: vi.fn(async () => ({ messageSid: "SMsynthetic", status: "queued" })) }))
vi.mock("@/lib/aurinko", async original => ({ ...await original<typeof import("@/lib/aurinko")>(), getAccessTokenForShop: vi.fn(async () => "synthetic-token"), sendEmailMessage: vi.fn(async () => ({ id: "synthetic-email" })) }))
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

const ACCOUNT = 987655
const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")

describe.skipIf(!INTEGRATION_WITH_SESSION)("a queued qualification question is held at send when its record moved on", () => {
  let db: SupabaseClient, manager: SupabaseClient, foreignOwner: SupabaseClient, other: Seeded, foreign: Seeded
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); other = await seedShop(db, { password }); foreign = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); manager = await ownerSessionClient(other.email, password); foreignOwner = await ownerSessionClient(foreign.email, password)
    expect((await db.from("shops").update({
      twilio_phone_number: "+15550007777", byo_sms_verified: true, quiet_hours_start: 0, quiet_hours_end: 0,
      aurinko_account_id: ACCOUNT, aurinko_access_token_enc: "synthetic-encrypted-token",
    }).eq("id", shop.shopId)).error).toBeNull()
    const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: other.email, p_name: "Fictional Manager", p_role: "manager", p_capabilities: ["crm.read", "approvals.messages"] })
    expect(invite.error).toBeNull()
    expect((await manager.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
  })
  afterEach(() => vi.clearAllMocks())
  afterAll(async () => { for (const s of [shop, other, foreign]) if (s) await cleanup(db, s) })

  async function lead(channel: "sms" | "email") {
    const address = channel === "sms" ? phone() : `${randomUUID()}@example.test`
    const intake = await recordLeadIntake(db, { shopId: shop.shopId, channel: "synthetic", provider: "synthetic", providerEventId: randomUUID(), threadKey: randomUUID(), receivedAt: new Date().toISOString(), payload: { message: "Fictional coating question" } })
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
    return { workflowId: intake.workflowId, customerId: c.data!.id as string, address, latest: inbound.data!.id as string, channel }
  }
  type Lead = Awaited<ReturnType<typeof lead>>

  /** Queue the proposed question and attach the owner's reply-purpose proof. */
  async function queued(l: Lead) {
    const r = await owner.rpc("read_lead_qualification", { p_shop: shop.shopId, p_workflow: l.workflowId })
    expect(r.error).toBeNull()
    const p = proposeNextQualificationQuestion(qualificationSchema.parse(r.data))
    if (p.kind !== "question") throw new Error(`expected a question, got ${p.kind}`)
    const commandId = randomUUID()
    expect(await stageQualificationQuestion({
      shopId: shop.shopId, workflowId: l.workflowId, commandId, basis: p.basis, target: p.target, questionId: p.question_id,
      channel: l.channel, conversation: { latestId: l.latest, revision: 0 },
      message: { body: p.text, subject: l.channel === "email" ? "A quick question about your request" : "", destination: l.address },
    })).toMatchObject({ ok: true, status: "queued" })
    expect(await reviewCommunicationPurpose(commandId, "reply")).toMatchObject({ ok: true })
    return { id: commandId, revision: p.basis.revision }
  }
  /** The owner records the answer to the queued question: the record moves on. */
  async function answered(l: Lead, revision: number) {
    const fields = unknownQualificationFields()
    const save = await owner.rpc("update_lead_qualification", {
      p_shop: shop.shopId, p_workflow: l.workflowId, p_command: randomUUID(), p_revision: revision, p_customer: l.customerId, p_vehicle: null,
      p_review_state: "in_progress", p_open_questions: [],
      p_fields: { ...fields, service: { status: "reported", source: "customer", evidence_revision: null, service_id: null, text: "Ceramic coating" } },
    })
    expect(save.error).toBeNull()
  }
  const execute = (id: string, client: SupabaseClient = owner) => executeApproval(client, id, shop.shopId, { userId: shop.ownerId })
  const outbound = async (id: string) => (await db.from("interactions").select("id").eq("shop_id", shop.shopId).eq("metadata->>pending_action_id", id)).data ?? []
  const reviewHash = async (id: string) => {
    const page = await manager.rpc("list_delegated_message_approvals", { p_shop: shop.shopId, p_offset: 0 })
    expect(page.error).toBeNull()
    return page.data.items.find((x: { action_id: string }) => x.action_id === id)?.review_hash as string
  }

  for (const channel of ["sms", "email"] as const) {
    const transport = channel === "sms" ? sendOutboundSms : sendEmailMessage

    it(`${channel}: answered after queueing, the owner's approval is held with zero external effects`, async () => {
      const l = await lead(channel), q = await queued(l)
      await answered(l, q.revision)
      const result = await execute(q.id)
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("qualification changed") })
      expect((await db.from("pending_actions").select("status,result_id").eq("id", q.id).single()).data).toEqual({ status: "pending", result_id: null })
      expect(await readMessageDeliveryReview(owner, shop.shopId, q.id)).toEqual({ state: "unspent" })
      expect(await outbound(q.id)).toEqual([])
      expect(transport).not.toHaveBeenCalled()
      expect(getAccessTokenForShop).not.toHaveBeenCalled()
    })

    it(`${channel}: a question that is still current sends once, as before`, async () => {
      const l = await lead(channel), q = await queued(l)
      expect(await execute(q.id)).toMatchObject({ ok: true, status: "executed" })
      expect(transport).toHaveBeenCalledTimes(1)
      expect(await outbound(q.id)).toHaveLength(1)
    })
  }

  it("delegated manager approval runs the same check as the service role: stale held, current sent", async () => {
    const stale = await lead("sms"), s = await queued(stale)
    await answered(stale, s.revision)
    const held = await executeApproval(manager, s.id, shop.shopId, { userId: other.ownerId }, { delegated: { expectedReview: await reviewHash(s.id), executionClient: serviceClient() } })
    expect(held).toMatchObject({ ok: false, error: expect.stringContaining("qualification changed") })
    expect(sendOutboundSms).not.toHaveBeenCalled()
    const current = await lead("sms"), c = await queued(current)
    expect(await executeApproval(manager, c.id, shop.shopId, { userId: other.ownerId }, { delegated: { expectedReview: await reviewHash(c.id), executionClient: serviceClient() } })).toMatchObject({ ok: true, status: "executed" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
  })

  it("an ordinary Whisper reply without a qualification binding is unaffected", async () => {
    const l = await lead("sms"), id = randomUUID()
    expect((await owner.rpc("whisper_command", { p_shop: shop.shopId, p_customer: l.customerId, p_channel: "sms", p_command: id, p_latest: l.latest, p_revision: 0, p_operation: "reply", p_payload: { destination: l.address, body: "Fictional answer", subject: "" } })).error).toBeNull()
    expect(await reviewCommunicationPurpose(id, "reply")).toMatchObject({ ok: true })
    expect(await owner.rpc("qualification_question_currency", { p_shop: shop.shopId, p_action: id })).toMatchObject({ data: null, error: null })
    expect(await execute(id)).toMatchObject({ ok: true, status: "executed" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
  })

  it("only this shop's owner, a manager with customer access, or the service role can run the check", async () => {
    const l = await lead("sms"), q = await queued(l)
    await answered(l, q.revision)
    for (const client of [owner, manager, serviceClient()]) {
      expect(await client.rpc("qualification_question_currency", { p_shop: shop.shopId, p_action: q.id })).toMatchObject({ data: "qualification_changed", error: null })
    }
    for (const client of [foreignOwner, anonClient()]) {
      expect((await client.rpc("qualification_question_currency", { p_shop: shop.shopId, p_action: q.id })).error?.code).toBe("42501")
    }
  })
})
