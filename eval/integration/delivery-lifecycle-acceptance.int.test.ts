import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { executeApproval } from "@/lib/approvals"
import { encryptSecret } from "@/lib/crypto"
import { sendOutboundSms } from "@/lib/twilio"
import { inboundSmsIntakeInput, recordLeadIntake } from "@/lib/lead-intake"
import { proposeNextQualificationQuestion, qualificationSchema } from "@/lib/lead-qualification"
import { readMessageDeliveryReview } from "@/lib/message-delivery-review"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, cleanup, type Seeded } from "./_db"

// PR3: one business's message lifecycle, end to end, against the real disposable
// database: intake → qualification → owner-queued question → approval → exactly
// one send → an early delivery callback → failed and uncertain delivery → a
// conflicting outcome reviewed on the delivery-review surface → a STOP before
// execution. Owner, delegated manager and revoked member. The interaction
// history, SMS gate, signed status and inbound routes, consent keywords and both
// delivery contracts (PR1 early evidence, PR2 conflict review) are real. Only
// the Twilio transport, the model-backed classifier/drafter and embeddings are
// faked; nothing leaves the machine and nothing is resent automatically.
const transport = vi.hoisted(() => ({ beforeReturn: null as null | ((sid: string) => Promise<void>) }))
const twilioSid = () => "SM" + randomBytes(16).toString("hex")
vi.mock("@/lib/twilio", async original => ({
  ...await original<typeof import("@/lib/twilio")>(),
  sendOutboundSms: vi.fn(async () => {
    const sid = twilioSid()
    if (transport.beforeReturn) await transport.beforeReturn(sid)
    return { messageSid: sid, status: "queued" }
  }),
}))
vi.mock("@/lib/embeddings", () => ({
  EMBEDDING_MODEL: "test-disabled",
  embedText: async () => { throw new Error("embeddings disabled in integration test") },
  embedTexts: async () => { throw new Error("embeddings disabled in integration test") },
}))
vi.mock("@/lib/sms-classifier", () => ({ classifySms: vi.fn(async () => ({ is_lead: false })) }))
vi.mock("@/lib/sms-drafter", async original => ({ ...await original<typeof import("@/lib/sms-drafter")>(), draftSmsReply: vi.fn(async () => null) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }))
vi.mock("@/lib/credits", async original => ({ ...await original<typeof import("@/lib/credits")>(), recordUsage: vi.fn() }))
vi.mock("@/lib/pricing", async original => ({ ...await original<typeof import("@/lib/pricing")>(), getPricing: vi.fn(), priceUsage: () => ({ credits: 0, wholesale_cost: 0, retail_cost: 0 }) }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
import { stageQualificationQuestion } from "@/app/actions/lead-qualification"
import { reviewCommunicationPurpose } from "@/app/actions/approvals"
let owner: SupabaseClient, shop: Seeded
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({ id: shop.ownerId }), requireShop: async () => ({ id: shop.shopId }) }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => owner }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const ORIGIN = "https://gradia.test"
const BUSINESS_NUMBER = "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const OTHER_NUMBER = "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const sign = (token: string, url: string, form: URLSearchParams) =>
  createHmac("sha1", token).update(url + [...form.keys()].sort().map((k) => k + form.get(k)).join("")).digest("base64")

describe.skipIf(!INTEGRATION_WITH_SESSION)("message lifecycle acceptance: send, delivery evidence, conflict review, opt-out", () => {
  let db: SupabaseClient, manager: SupabaseClient, revoked: SupabaseClient, mgr: Seeded, gone: Seeded
  // Opaque synthetic tokens for the shops' own (BYO) Twilio accounts: they sign the fake callbacks.
  const ownToken = "synthetic-own-token-" + randomUUID(), otherToken = "synthetic-other-token-" + randomUUID()
  const caps = ["crm.read", "leads.qualify", "approvals.messages", "delivery.reconcile"]
  let statusRoute: typeof import("@/app/api/twilio/sms/status/route").POST
  let inboundRoute: typeof import("@/app/api/twilio/sms/route").POST

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= "ab".repeat(32)
    process.env.GRADIA_DASHBOARD_URL = ORIGIN
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL // the disposable stack, asserted by serviceClient
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); mgr = await seedShop(db, { password }); gone = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password)
    manager = await ownerSessionClient(mgr.email, password); revoked = await ownerSessionClient(gone.email, password)
    const own = (number: string, token: string) => ({
      twilio_phone_number: number, twilio_account_sid_enc: encryptSecret("AC" + randomBytes(16).toString("hex")), twilio_auth_token_enc: encryptSecret(token),
    })
    // Own-number texting, attested (service role, as in the existing suites), with quiet hours off.
    expect((await db.from("shops").update({ ...own(BUSINESS_NUMBER, ownToken), byo_sms_verified: true, quiet_hours_start: 0, quiet_hours_end: 0 }).eq("id", shop.shopId)).error).toBeNull()
    // A second business with its own account, used for cross-business misuse.
    expect((await db.from("shops").update(own(OTHER_NUMBER, otherToken)).eq("id", mgr.shopId)).error).toBeNull()
    for (const [client, who] of [[manager, mgr], [revoked, gone]] as const) {
      const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: who.email, p_name: "Fictional Manager", p_role: "manager", p_capabilities: caps })
      expect(invite.error).toBeNull()
      expect((await client.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
    }
    expect((await db.from("shop_memberships").update({ active: false }).eq("shop_id", shop.shopId).eq("user_id", gone.ownerId)).error).toBeNull()
    ;({ POST: statusRoute } = await import("@/app/api/twilio/sms/status/route"))
    ;({ POST: inboundRoute } = await import("@/app/api/twilio/sms/route"))
  })
  afterEach(() => { vi.mocked(sendOutboundSms).mockClear(); transport.beforeReturn = null })
  afterAll(async () => { for (const s of [shop, mgr, gone]) if (s) await cleanup(db, s) })

  /** A signed Twilio delivery-status callback, as `shopId`'s account would sign it. */
  async function callback(sid: string, status: string, opts: { errorCode?: string; shopId?: string; token?: string } = {}) {
    const url = `${ORIGIN}/api/twilio/sms/status?shop=${opts.shopId ?? shop.shopId}`
    const form = new URLSearchParams({ MessageSid: sid, MessageStatus: status, ...(opts.errorCode ? { ErrorCode: opts.errorCode } : {}) })
    const res = await statusRoute(new Request(url, { method: "POST", body: form.toString(), headers: { "x-twilio-signature": sign(opts.token ?? ownToken, url, form), "content-type": "application/x-www-form-urlencoded" } }))
    return res.status
  }
  /** A signed inbound text from the customer to the business number. */
  async function inbound(from: string, body: string) {
    const url = `${ORIGIN}/api/twilio/sms`
    const form = new URLSearchParams({ MessageSid: twilioSid(), From: from, To: BUSINESS_NUMBER, Body: body })
    const res = await inboundRoute(new Request(url, { method: "POST", body: form.toString(), headers: { "x-twilio-signature": sign(ownToken, url, form), "content-type": "application/x-www-form-urlencoded" } }))
    return res.status
  }

  /** A customer texts in; intake records it and the owner links the identity. */
  async function lead() {
    const from = phone(), sid = twilioSid(), receivedAt = new Date().toISOString()
    const intake = await recordLeadIntake(db, inboundSmsIntakeInput({ shopId: shop.shopId, messageSid: sid, from, body: "Fictional coating question", receivedAt }))
    expect(intake).toMatchObject({ status: "recorded", state: "identity_review" })
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Lead", phone: from, do_not_contact: false }).select("id,name,phone,email,updated_at").single()
    expect(c.error).toBeNull()
    expect((await owner.rpc("link_intake_customer", { p_shop: shop.shopId, p_workflow: intake.workflowId, p_revision: intake.revision, p_customer: c.data!.id, p_snapshot: c.data, p_command: randomUUID() })).error).toBeNull()
    const m = await db.from("interactions").insert({ shop_id: shop.shopId, customer_id: c.data!.id, channel: "sms", role: "customer", content: "Fictional coating question", metadata: { direction: "inbound", from_phone: from, twilio_message_sid: sid } }).select("id").single()
    expect(m.error).toBeNull()
    return { workflowId: intake.workflowId, customerId: c.data!.id as string, phone: from, latest: m.data!.id as string }
  }
  type Lead = Awaited<ReturnType<typeof lead>>
  /** The owner reviews the proposed qualification question and queues it, with reply purpose attached. */
  async function queued(l: Lead) {
    const read = await owner.rpc("read_lead_qualification", { p_shop: shop.shopId, p_workflow: l.workflowId })
    expect(read.error).toBeNull()
    const p = proposeNextQualificationQuestion(qualificationSchema.parse(read.data))
    if (p.kind !== "question") throw new Error(`expected a question, got ${p.kind}`)
    const commandId = randomUUID()
    expect(await stageQualificationQuestion({
      shopId: shop.shopId, workflowId: l.workflowId, commandId, basis: p.basis, target: p.target, questionId: p.question_id,
      channel: "sms", conversation: { latestId: l.latest, revision: 0 }, message: { body: p.text, subject: "", destination: l.phone },
    })).toMatchObject({ ok: true, status: "queued", actionId: commandId })
    expect(await reviewCommunicationPurpose(commandId, "reply")).toMatchObject({ ok: true })
    return commandId
  }
  const ownerApprove = (id: string) => executeApproval(owner, id, shop.shopId, { userId: shop.ownerId })
  async function managerApprove(id: string, client = manager, userId = mgr.ownerId) {
    const page = await client.rpc("list_delegated_message_approvals", { p_shop: shop.shopId, p_offset: 0 })
    const review = page.error ? "0".repeat(64) : (page.data.items.find((x: { action_id: string }) => x.action_id === id)?.review_hash as string ?? "0".repeat(64))
    return executeApproval(client, id, shop.shopId, { userId }, { delegated: { expectedReview: review, executionClient: serviceClient() } })
  }
  const outbound = async (actionId: string) =>
    (await db.from("interactions").select("id,metadata").eq("shop_id", shop.shopId).eq("metadata->>pending_action_id", actionId)).data ?? []
  const pendingFor = async (workflowId: string) =>
    (await db.from("pending_actions").select("id,status").eq("shop_id", shop.shopId).eq("payload->qualification->>workflow_id", workflowId)).data ?? []

  it("one approved send; its terminal result arriving before the interaction is saved is kept and applied", async () => {
    const l = await lead(), id = await queued(l)
    expect(sendOutboundSms).not.toHaveBeenCalled()
    // Twilio's callback beats the send path's insert: it reaches the route while the send is still returning.
    const early: number[] = []
    transport.beforeReturn = async (sid) => { early.push(await callback(sid, "delivered")) }
    expect(await managerApprove(id)).toMatchObject({ ok: true, status: "executed" })
    expect(early).toEqual([200])
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    const [msg] = await outbound(id)
    expect(msg.metadata).toMatchObject({ twilio_status: "delivered", pending_action_id: id })
    // A late, lower status never moves it back; a retried approval sends nothing.
    expect(await callback(msg.metadata.twilio_message_sid, "sent")).toBe(200)
    expect((await outbound(id))[0].metadata.twilio_status).toBe("delivered")
    expect(await ownerApprove(id)).toMatchObject({ ok: true, status: "already_decided" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await readMessageDeliveryReview(owner, shop.shopId, id)).toMatchObject({ state: "provider_accepted" })
  })

  it("a failed delivery stays failed, is never resent, and another business can't rewrite it", async () => {
    const l = await lead(), id = await queued(l)
    expect(await ownerApprove(id)).toMatchObject({ ok: true, status: "executed" })
    const sid = (await outbound(id))[0].metadata.twilio_message_sid as string
    expect(await callback(sid, "failed", { errorCode: "30008" })).toBe(200)
    // Cross-business: the other business's account signs a "delivered" for this SID under its own shop.
    expect(await callback(sid, "delivered", { shopId: mgr.shopId, token: otherToken })).toBe(200)
    // And it can't pass for this shop: wrong signer for ?shop=.
    expect(await callback(sid, "delivered", { token: otherToken })).toBe(401)
    expect((await outbound(id))[0].metadata).toMatchObject({ twilio_status: "failed", twilio_error_code: "30008" })
    expect(await ownerApprove(id)).toMatchObject({ ok: true, status: "already_decided" })
    expect(await managerApprove(id)).toMatchObject({ ok: true, status: "already_decided" })
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await pendingFor(l.workflowId)).toHaveLength(1)
  })

  it("an uncertain send is held: no approval path resends it and no replacement can be queued", async () => {
    const l = await lead(), id = await queued(l)
    vi.mocked(sendOutboundSms).mockRejectedValueOnce(new Error("Synthetic timeout: outcome unknown"))
    expect(await ownerApprove(id)).toMatchObject({ ok: false })
    expect(await readMessageDeliveryReview(owner, shop.shopId, id)).toMatchObject({ state: "claimed" })
    for (const retry of [() => ownerApprove(id), () => managerApprove(id), () => executeApproval(serviceClient(), id, shop.shopId, { userId: shop.ownerId })]) {
      expect(await retry()).toMatchObject({ ok: false })
    }
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await outbound(id)).toEqual([])
    await expect(queued(l)).rejects.toThrow()
    expect(await pendingFor(l.workflowId)).toHaveLength(1)
  })

  it("contradictory delivered/failed results are shown as conflicting, reviewed by the manager, and refused to a revoked member", async () => {
    const l = await lead(), id = await queued(l)
    expect(await managerApprove(id)).toMatchObject({ ok: true, status: "executed" })
    const [msg] = await outbound(id)
    const sid = msg.metadata.twilio_message_sid as string
    expect(await callback(sid, "delivered")).toBe(200)
    expect(await callback(sid, "undelivered", { errorCode: "30003" })).toBe(200)
    const after = (await outbound(id))[0].metadata
    expect(after).toMatchObject({ twilio_status: "delivered", twilio_status_conflict: { status: "undelivered", error_code: "30003" } })

    // Never an unqualified success on the delivery-review surface.
    const listed = await manager.rpc("list_delivery_conflicts", { p_shop: shop.shopId, p_offset: 0 })
    expect(listed.error).toBeNull()
    const item = listed.data.items.find((x: { interaction_id: string }) => x.interaction_id === msg.id)
    expect(item).toMatchObject({ delivery_state: "conflicting", resolution_state: "unresolved", recorded_status: "delivered", conflict_status: "undelivered", action_id: id })

    // A revoked member can neither read nor resolve.
    expect((await revoked.rpc("list_delivery_conflicts", { p_shop: shop.shopId, p_offset: 0 })).error?.code).toBe("42501")
    const resolve = (client: SupabaseClient) => client.rpc("record_delivery_conflict_resolution", {
      p_shop: shop.shopId, p_interaction: msg.id, p_command: randomUUID(), p_revision: item.review_revision,
      p_conflict_received_at: item.conflict_received_at, p_outcome: "not_delivered", p_note: "Fictional: checked the carrier log, undelivered.",
    })
    expect((await resolve(revoked)).error?.code).toBe("42501")
    expect((await resolve(manager)).error).toBeNull()
    const reviewed = (await manager.rpc("read_delivery_conflict", { p_shop: shop.shopId, p_interaction: msg.id, p_offset: 0 })).data
    expect(reviewed).toMatchObject({ resolution_state: "resolved", latest_outcome: "not_delivered", delivery_state: "conflicting" })
    expect(reviewed.history[0]).toMatchObject({ outcome: "not_delivered" })

    // The review is evidence only: delivery metadata unchanged, nothing resent, no new action.
    expect((await outbound(id))[0].metadata).toEqual(after)
    expect(sendOutboundSms).toHaveBeenCalledTimes(1)
    expect(await pendingFor(l.workflowId)).toHaveLength(1)
  })

  it("a STOP through the signed inbound route after queueing holds the send with zero transport", async () => {
    const l = await lead(), id = await queued(l)
    expect(await inbound(l.phone, "STOP")).toBe(200)
    expect((await db.from("customers").select("sms_opted_out_at").eq("id", l.customerId).single()).data!.sms_opted_out_at).not.toBeNull()
    expect(await ownerApprove(id)).toMatchObject({ ok: false })
    expect(await managerApprove(id)).toMatchObject({ ok: false })
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(await outbound(id)).toEqual([])
    expect((await db.from("pending_actions").select("status").eq("id", id).single()).data!.status).toBe("pending")
  })
})
