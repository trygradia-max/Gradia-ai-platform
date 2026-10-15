import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { sendOutboundSms } from "@/lib/twilio"
import { inboundSmsIntakeInput, recordLeadIntake, websiteFormIntakeInput } from "@/lib/lead-intake"
import { proposeNextQualificationQuestion, qualificationSchema, unknownQualificationFields } from "@/lib/lead-qualification"
import { readMessageDeliveryReview } from "@/lib/message-delivery-review"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, cleanup, type Seeded } from "./_db"

// B2 connected lead-workflow acceptance. Disposable stack only: synthetic shops,
// people and numbers. The provider seam is faked; nothing leaves the machine.
vi.mock("@/lib/telephony-provider", async original => ({ ...await original<typeof import("@/lib/telephony-provider")>(), smsGateForShop: () => ({ allowed: true }) }))
vi.mock("@/lib/twilio", async original => ({ ...await original<typeof import("@/lib/twilio")>(), sendOutboundSms: vi.fn(async () => ({ messageSid: "synthetic-message", status: "queued" })) }))
vi.mock("@/lib/memory", async original => ({ ...await original<typeof import("@/lib/memory")>(), recordInteraction: vi.fn(async () => ({ ok: true as const, id: randomUUID(), embedded: false })) }))
vi.mock("@/lib/credits", () => ({ recordUsage: vi.fn() }))
vi.mock("@/lib/pricing", async original => ({ ...await original<typeof import("@/lib/pricing")>(), getPricing: vi.fn(), priceUsage: () => ({ credits: 0, wholesale_cost: 0, retail_cost: 0 }) }))
import { stageQualificationQuestion } from "@/app/actions/lead-qualification"
import { reviewCommunicationPurpose } from "@/app/actions/approvals"
let owner: SupabaseClient, shop: Seeded
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: shop.ownerId }), requireShop: async () => ({ id: shop.shopId }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => owner }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const BUSINESS_NUMBER = "+15550002222"
const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")

describe.skipIf(!INTEGRATION_WITH_SESSION)("connected lead workflow: intake → qualification → queued question → approval → transport", () => {
  let db: SupabaseClient, manager: SupabaseClient, other: Seeded
  const delegated = ["crm.read", "leads.qualify", "approvals.messages"]
  const membership = (values: Record<string, unknown>) => db.from("shop_memberships").update(values).eq("shop_id", shop.shopId).eq("user_id", other.ownerId)

  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); other = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); manager = await ownerSessionClient(other.email, password)
    expect((await db.from("shops").update({ twilio_phone_number: BUSINESS_NUMBER, byo_sms_verified: true, quiet_hours_start: 0, quiet_hours_end: 0 }).eq("id", shop.shopId)).error).toBeNull()
    const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: other.email, p_name: "Fictional Manager", p_role: "manager", p_capabilities: delegated })
    expect(invite.error).toBeNull()
    expect((await manager.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
  })
  afterEach(() => vi.clearAllMocks())
  afterAll(async () => { for (const s of [shop, other]) if (s) await cleanup(db, s) })

  /**
   * A customer texts the shop: the verified inbound SMS is recorded as intake
   * (the provider redelivers it once), the owner links the identity, and the
   * message is in the SMS thread.
   */
  async function smsLead() {
    const from = phone(), sid = "SM" + randomUUID().replace(/-/g, ""), receivedAt = new Date().toISOString()
    const input = inboundSmsIntakeInput({ shopId: shop.shopId, messageSid: sid, from, body: "Fictional coating question", receivedAt })
    const first = await recordLeadIntake(db, input), redelivered = await recordLeadIntake(db, input)
    expect(first).toMatchObject({ status: "recorded", state: "identity_review" })
    expect(redelivered).toMatchObject({ status: "already_recorded", workflowId: first.workflowId, transitionId: first.transitionId })
    expect((await db.from("lead_workflows").select("id").eq("shop_id", shop.shopId).eq("id", first.workflowId)).data).toHaveLength(1)
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Lead", phone: from, do_not_contact: false }).select("id,name,phone,email,updated_at").single()
    expect(c.error).toBeNull()
    const link = await owner.rpc("link_intake_customer", { p_shop: shop.shopId, p_workflow: first.workflowId, p_revision: first.revision, p_customer: c.data!.id, p_snapshot: c.data, p_command: randomUUID() })
    expect(link.error).toBeNull()
    const inbound = await db.from("interactions").insert({ shop_id: shop.shopId, customer_id: c.data!.id, channel: "sms", role: "customer", content: "Fictional coating question", metadata: { direction: "inbound", from_phone: from, twilio_sid: sid } }).select("id").single()
    expect(inbound.error).toBeNull()
    return { workflowId: first.workflowId, customerId: c.data!.id as string, phone: from, latest: inbound.data!.id as string }
  }
  type Lead = Awaited<ReturnType<typeof smsLead>>

  async function proposal(workflowId: string) {
    const r = await owner.rpc("read_lead_qualification", { p_shop: shop.shopId, p_workflow: workflowId })
    expect(r.error).toBeNull()
    return proposeNextQualificationQuestion(qualificationSchema.parse(r.data))
  }
  /** The input the review screen sends, built from the current proposal and thread. */
  async function reviewed(l: Pick<Lead, "workflowId" | "phone" | "latest">, commandId = randomUUID()) {
    const p = await proposal(l.workflowId)
    if (p.kind !== "question") throw new Error(`expected a question, got ${p.kind}`)
    return {
      shopId: shop.shopId, workflowId: l.workflowId, commandId, basis: p.basis, target: p.target, questionId: p.question_id,
      channel: "sms" as const, conversation: { latestId: l.latest, revision: 0 },
      message: { body: p.text, subject: "", destination: l.phone },
    }
  }
  async function queued(l: Lead) {
    const input = await reviewed(l)
    expect(await stageQualificationQuestion(input)).toEqual({ ok: true, status: "queued", actionId: input.commandId, workflowId: l.workflowId, channel: "sms" })
    return input.commandId
  }
  const execute = (id: string, client: SupabaseClient = owner) => executeApproval(client, id, shop.shopId, { userId: shop.ownerId })
  const row = async (id: string) => (await db.from("pending_actions").select("status,result_id,decided_by_user").eq("id", id).single()).data
  const hash = async (id: string) => {
    const page = await manager.rpc("list_delegated_message_approvals", { p_shop: shop.shopId, p_offset: 0 })
    expect(page.error).toBeNull()
    return page.data.items.find((x: { action_id: string }) => x.action_id === id)?.review_hash as string
  }
  const delegatedApprove = async (id: string) =>
    executeApproval(manager, id, shop.shopId, { userId: other.ownerId }, { delegated: { expectedReview: await hash(id), executionClient: serviceClient() } })

  it("the whole path sends exactly once, only after approval with send-time proof, and is never reported as delivered", async () => {
    const l = await smsLead()
    const id = await queued(l)
    // Queued is not sent: no transport, no execution ledger, no outbound message.
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(await row(id)).toEqual({ status: "pending", result_id: null, decided_by_user: null })
    expect(await readMessageDeliveryReview(owner, shop.shopId, id)).toEqual({ state: "unspent" })

    // Approval without marketing consent or reviewed reply purpose is held at send.
    expect(await execute(id)).toMatchObject({ ok: false })
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(await row(id)).toEqual({ status: "pending", result_id: null, decided_by_user: null })

    // The owner attaches the existing reply-purpose proof to the recent inbound text.
    expect(await reviewCommunicationPurpose(id, "reply")).toMatchObject({ ok: true })
    const results = await Promise.all([execute(id), execute(id, serviceClient())])
    expect(results.filter(r => r.ok && r.status === "executed"), JSON.stringify(results)).toHaveLength(1)
    expect(await execute(id)).toMatchObject({ ok: true, status: "already_decided" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendOutboundSms).mock.calls[0][0]).toMatchObject({ to: l.phone, from: BUSINESS_NUMBER, body: "Which service are you interested in?" })

    // Provider acceptance, not delivery. No consent was invented for the lead.
    expect(await readMessageDeliveryReview(owner, shop.shopId, id)).toMatchObject({ state: "provider_accepted" })
    expect((await db.from("customer_channel_permissions").select("id").eq("shop_id", shop.shopId).eq("customer_id", l.customerId)).data).toEqual([])
    // An exact retry of the staging command is still the same action, never a second message.
    expect(await stageQualificationQuestion({ ...(await reviewed(l, id)) })).toMatchObject({ ok: true, status: "already_queued", actionId: id })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
  })

  it("stale evidence refuses staging with zero transport", async () => {
    const l = await smsLead()
    const stale = await reviewed(l)
    const save = await owner.rpc("update_lead_qualification", {
      p_shop: shop.shopId, p_workflow: l.workflowId, p_command: randomUUID(), p_revision: 0, p_customer: l.customerId, p_vehicle: null,
      p_review_state: "in_progress", p_fields: unknownQualificationFields(), p_open_questions: [],
    })
    expect(save.error).toBeNull()
    expect(await stageQualificationQuestion(stale)).toEqual({ ok: false, code: "qualification_changed" })
    expect((await db.from("pending_actions").select("id").eq("shop_id", shop.shopId).eq("payload->qualification->>workflow_id", l.workflowId)).data).toEqual([])
    expect(sendOutboundSms).not.toHaveBeenCalled()
  })

  it("a changed recipient, DNC or STOP after queueing blocks transport at send", async () => {
    for (const change of [{ phone: phone() }, { do_not_contact: true }, { sms_opted_out_at: new Date().toISOString() }]) {
      const l = await smsLead(), id = await queued(l)
      expect(await reviewCommunicationPurpose(id, "reply")).toMatchObject({ ok: true })
      expect((await db.from("customers").update(change).eq("id", l.customerId)).error).toBeNull()
      expect(await execute(id), JSON.stringify(change)).toMatchObject({ ok: false })
      expect((await row(id))?.status).toBe("pending")
    }
    expect(sendOutboundSms).not.toHaveBeenCalled()
  })

  it("a manager can approve the owner-queued message but cannot queue one, and loses approval when access is revoked", async () => {
    const l = await smsLead()
    const managerStage = await manager.rpc("stage_qualification_question", {
      p_shop: shop.shopId, p_workflow: l.workflowId, p_command: randomUUID(), p_revision: 0, p_evidence_revision: 1, p_target: "service",
      p_question: null, p_channel: "sms", p_latest: l.latest, p_conversation_revision: 0, p_payload: { body: "Fictional", subject: "", destination: l.phone },
    })
    expect(managerStage.error?.code).toBe("42501")

    const id = await queued(l)
    expect(await reviewCommunicationPurpose(id, "reply")).toMatchObject({ ok: true })
    expect((await membership({ active: false })).error).toBeNull()
    try {
      const denied = await executeApproval(manager, id, shop.shopId, { userId: other.ownerId }, { delegated: { expectedReview: "0".repeat(64), executionClient: serviceClient() } })
      expect(denied.ok).toBe(false)
      expect((await row(id))?.status).toBe("pending")
      expect(sendOutboundSms).not.toHaveBeenCalled()
    } finally {
      expect((await membership({ active: true })).error).toBeNull()
    }
    expect(await delegatedApprove(id)).toMatchObject({ ok: true, status: "executed" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await row(id)).toMatchObject({ status: "approved", decided_by_user: other.ownerId })
  })

  it("an unknown provider outcome stays held: no retry resends and no replacement question can be queued", async () => {
    const l = await smsLead(), id = await queued(l)
    expect(await reviewCommunicationPurpose(id, "reply")).toMatchObject({ ok: true })
    vi.mocked(sendOutboundSms).mockRejectedValueOnce(new Error("Synthetic timeout: outcome unknown"))
    expect(await execute(id)).toMatchObject({ ok: false })
    expect(await readMessageDeliveryReview(owner, shop.shopId, id)).toMatchObject({ state: "claimed" })
    expect(await execute(id)).toMatchObject({ ok: false })
    expect(await execute(id, serviceClient())).toMatchObject({ ok: false })
    expect(await delegatedApprove(id)).toMatchObject({ ok: false })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await stageQualificationQuestion(await reviewed(l))).toEqual({ ok: false, code: "question_pending" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
  })

  it("a website-only lead with no conversation is refused, not bypassed", async () => {
    const intake = await recordLeadIntake(db, websiteFormIntakeInput({
      shopId: shop.shopId, submissionId: randomUUID(), receivedAt: new Date().toISOString(),
      payload: { display_name: "Fictional Web Lead", phone: phone(), message: "Fictional request" },
    }))
    const destination = phone()
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Web Lead", phone: destination, do_not_contact: false, marketing_consent_at: new Date().toISOString() }).select("id,name,phone,email,updated_at").single()
    expect(c.error).toBeNull()
    expect((await owner.rpc("link_intake_customer", { p_shop: shop.shopId, p_workflow: intake.workflowId, p_revision: intake.revision, p_customer: c.data!.id, p_snapshot: c.data, p_command: randomUUID() })).error).toBeNull()
    // There is no thread, so the only id a screen could send is not a message in one.
    const result = await stageQualificationQuestion(await reviewed({ workflowId: intake.workflowId, phone: destination, latest: randomUUID() }))
    expect(result).toEqual({ ok: false, code: "conversation_changed" })
    expect((await db.from("pending_actions").select("id").eq("shop_id", shop.shopId).eq("payload->qualification->>workflow_id", intake.workflowId)).data).toEqual([])
    expect(sendOutboundSms).not.toHaveBeenCalled()
  })
})
