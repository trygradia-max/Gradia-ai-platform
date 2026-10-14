import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"
import { recordLeadIntake } from "@/lib/lead-intake"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
import {
  proposeNextQualificationQuestion, qualificationQuestionStagedSchema, qualificationQuestionStageRefusal,
  qualificationSchema, unknownQualificationFields,
} from "@/lib/lead-qualification"

// Disposable stack only. Synthetic shops, people and numbers; nothing is sent.
let db: SupabaseClient, owner: SupabaseClient, manager: SupabaseClient, foreignOwner: SupabaseClient
let shop: Seeded, other: Seeded, foreign: Seeded
const BUSINESS_NUMBER = "+15555550100"

const phone = () => "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0")
const intake = (threadKey: string) =>
  recordLeadIntake(db, { shopId: shop.shopId, channel: "synthetic", provider: "synthetic", providerEventId: randomUUID(), threadKey, receivedAt: new Date().toISOString(), payload: { service_text: "Fictional ceramic coating request" } })

/** A linked lead with an inbound SMS thread, as a shop would have after a customer texted. */
async function lead() {
  const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Lead", phone: phone(), email: `${randomUUID()}@example.test` }).select("id,name,phone,email,updated_at").single()
  expect(c.error).toBeNull()
  const thread = randomUUID(), w = await intake(thread)
  expect((await owner.rpc("link_intake_customer", { p_shop: shop.shopId, p_workflow: w.workflowId, p_revision: 1, p_customer: c.data!.id, p_snapshot: c.data, p_command: randomUUID() })).error).toBeNull()
  const latest = await inbound(c.data!.id, c.data!.phone)
  return { workflowId: w.workflowId, customerId: c.data!.id as string, phone: c.data!.phone as string, email: c.data!.email as string, thread, latest }
}
type Lead = Awaited<ReturnType<typeof lead>>
async function inbound(customerId: string, from: string, channel = "sms") {
  const m = await db.from("interactions").insert({ shop_id: shop.shopId, customer_id: customerId, channel, role: "customer", content: "Fictional inquiry", metadata: { direction: "inbound", from_phone: from } }).select("id").single()
  expect(m.error).toBeNull()
  return m.data!.id as string
}
async function proposal(l: Lead) {
  const r = await owner.rpc("read_lead_qualification", { p_shop: shop.shopId, p_workflow: l.workflowId })
  expect(r.error).toBeNull()
  return proposeNextQualificationQuestion(qualificationSchema.parse(r.data))
}
/** The RPC arguments the action builds from the current proposal and thread. */
async function args(l: Lead, patch: Record<string, unknown> = {}) {
  const p = await proposal(l)
  const target = p.kind === "question" ? p.target : null
  const question = p.kind === "question" ? p.question_id : null
  return {
    p_shop: shop.shopId, p_workflow: l.workflowId, p_command: randomUUID(),
    p_revision: p.basis.revision, p_evidence_revision: p.basis.evidence_revision,
    p_target: target, p_question: question, p_channel: "sms", p_latest: l.latest, p_conversation_revision: 0,
    p_payload: { body: p.kind === "question" ? p.text : "Fictional", subject: "", destination: l.phone }, ...patch,
  }
}
const stage = (a: Record<string, unknown>, client = owner) => client.rpc("stage_qualification_question", a)
const refusal = (r: { error: { code?: string; details?: string | null } | null }) => r.error ? qualificationQuestionStageRefusal(r.error).code : "ok"
const pending = (workflowId: string) => db.from("pending_actions").select("*").eq("shop_id", shop.shopId).eq("payload->qualification->>workflow_id", workflowId)
async function save(l: Lead, revision: number, patch: Record<string, unknown> = {}) {
  const r = await owner.rpc("update_lead_qualification", {
    p_shop: shop.shopId, p_workflow: l.workflowId, p_command: randomUUID(), p_revision: revision, p_customer: l.customerId, p_vehicle: null,
    p_review_state: "in_progress", p_fields: unknownQualificationFields(), p_open_questions: [], ...patch,
  })
  expect(r.error).toBeNull()
}
const setShop = async (values: Record<string, unknown>) => expect((await db.from("shops").update(values).eq("id", shop.shopId)).error).toBeNull()

describe.skipIf(!INTEGRATION_WITH_SESSION)("queueing a reviewed qualification question", () => {
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); other = await seedShop(db, { password }); foreign = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password)
    manager = await ownerSessionClient(other.email, password); foreignOwner = await ownerSessionClient(foreign.email, password)
    const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: other.email, p_name: "Fictional Manager", p_role: "manager", p_capabilities: ["crm.read", "leads.qualify", "approvals.messages"] })
    expect(invite.error).toBeNull()
    expect((await manager.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
    await setShop({ twilio_phone_number: BUSINESS_NUMBER, byo_sms_verified: true })
  })
  afterAll(async () => { for (const s of [shop, other, foreign]) if (s) await cleanup(db, s) })

  it("queues the proposed question as one pending Whisper reply bound to the qualification, and sends nothing", async () => {
    const l = await lead(), a = await args(l)
    expect(a.p_target).toBe("service")
    const before = await db.from("interactions").select("id").eq("shop_id", shop.shopId).eq("customer_id", l.customerId)
    const r = await stage(a)
    expect(r.error).toBeNull()
    expect(qualificationQuestionStagedSchema.parse(r.data)).toMatchObject({ status: "queued", action_id: a.p_command, workflow_id: l.workflowId, channel: "sms" })
    const row = (await db.from("pending_actions").select("*").eq("id", a.p_command).single()).data!
    expect(row).toMatchObject({ shop_id: shop.shopId, action_type: "send_sms", status: "pending", requested_by: shop.ownerId, result_id: null })
    expect(row.payload).toEqual({
      category: "marketing", source: "whisper_inbox", customer_id: l.customerId, customer_name: "Fictional Lead",
      body: "Which service are you interested in?", to_phone: l.phone, conversation_interaction_id: l.latest,
      qualification: { workflow_id: l.workflowId, revision: 0, evidence_revision: 1, target: "service", question_id: null },
    })
    // The existing Whisper evidence resolves for it, exactly as for an inbox reply.
    const anchor = await owner.rpc("whisper_reply_context", { p_shop: shop.shopId, p_action: a.p_command })
    expect(anchor.error).toBeNull()
    expect(anchor.data).toMatchObject({ interaction_id: l.latest, customer_id: l.customerId, channel: "sms", destination: l.phone })
    // No outbound interaction, no execution ledger entry, and the record is unchanged.
    expect((await db.from("interactions").select("id").eq("shop_id", shop.shopId).eq("customer_id", l.customerId)).data).toEqual(before.data)
    expect((await db.from("service_proof_consumptions").select("*").eq("shop_id", shop.shopId)).data).toEqual([])
    expect((await proposal(l)).basis.revision).toBe(0)
  })

  it("an exact retry, including a concurrent one, returns the same action and writes nothing new", async () => {
    const l = await lead(), a = await args(l)
    const [x, y] = await Promise.all([stage(a), stage(a)])
    expect([x.error, y.error]).toEqual([null, null])
    expect([x.data.status, y.data.status].sort()).toEqual(["already_queued", "queued"])
    expect((await stage(a)).data).toMatchObject({ status: "already_queued", action_id: a.p_command })
    expect((await pending(l.workflowId)).data).toHaveLength(1)
    // A retry is answered from the record of the first call, even after the qualification moves on.
    await save(l, 0)
    expect((await stage(a)).data).toMatchObject({ status: "already_queued" })
  })

  it("the same command id with a different message or binding is a conflict", async () => {
    const l = await lead(), a = await args(l)
    expect((await stage(a)).error).toBeNull()
    expect(refusal(await stage({ ...a, p_payload: { ...a.p_payload, body: "Edited after review" } }))).toBe("command_conflict")
    expect(refusal(await stage({ ...a, p_target: "timing" }))).toBe("command_conflict")
    // A plain Whisper reply id cannot be replayed as a qualification question.
    const plain = randomUUID()
    expect((await owner.rpc("whisper_command", { p_shop: shop.shopId, p_customer: l.customerId, p_channel: "sms", p_command: plain, p_latest: l.latest, p_revision: 0, p_operation: "reply", p_payload: a.p_payload })).error).toBeNull()
    expect(refusal(await stage({ ...a, p_command: plain }))).toBe("command_conflict")
  })

  it("a second question for the same lead waits until the first is decided", async () => {
    const l = await lead(), a = await args(l)
    expect((await stage(a)).error).toBeNull()
    expect(refusal(await stage({ ...a, p_command: randomUUID() }))).toBe("question_pending")
    expect((await db.from("pending_actions").update({ status: "approved" }).eq("id", a.p_command)).error).toBeNull()
    expect(refusal(await stage({ ...a, p_command: randomUUID() }))).toBe("question_pending")
    expect((await db.from("pending_actions").update({ status: "rejected" }).eq("id", a.p_command)).error).toBeNull()
    expect((await stage({ ...a, p_command: randomUUID() })).error).toBeNull()
    expect((await pending(l.workflowId)).data).toHaveLength(2)
  })

  it("only the current proposal may be queued; an open question comes before unknown fields", async () => {
    const l = await lead()
    expect(refusal(await stage(await args(l, { p_target: "timing" })))).toBe("question_resolved")
    const q = { id: randomUUID(), text: "Is the vehicle garage kept?", status: "open", answer: null }
    await save(l, 0, { p_open_questions: [q] })
    const a = await args(l)
    expect(a).toMatchObject({ p_target: "open_question", p_question: q.id, p_revision: 1 })
    expect(refusal(await stage({ ...a, p_target: "service", p_question: null }))).toBe("question_resolved")
    expect(refusal(await stage({ ...a, p_question: randomUUID() }))).toBe("question_resolved")
    expect((await stage({ ...a, p_payload: { ...a.p_payload, body: "Quick one: is the car garage kept?" } })).error).toBeNull()
    // Nothing left to ask is not a question.
    const done = await lead()
    const known = { status: "reported", source: "customer", evidence_revision: null }
    await save(done, 0, { p_fields: {
      service: { ...known, service_id: null, text: "Ceramic coating" }, vehicle_condition: { ...known, text: "Fictional" },
      timing: { ...known, earliest: null, latest: null, text: "Fictional" }, location: { ...known, type: "shop", area: null }, constraints: { ...known, items: [] },
    } })
    expect(refusal(await stage(await args(done, { p_target: "service" })))).toBe("question_resolved")
  })

  it("a suggestion derived from an older revision or older evidence is refused", async () => {
    const l = await lead(), a = await args(l)
    await save(l, 0)
    expect(refusal(await stage(a))).toBe("qualification_changed")
    const b = await args(l)
    await intake(l.thread)
    expect(refusal(await stage(b))).toBe("qualification_changed")
    // Copying the new evidence revision does not get past review.
    const r = (await owner.rpc("read_lead_qualification", { p_shop: shop.shopId, p_workflow: l.workflowId })).data
    expect(refusal(await stage({ ...b, p_command: randomUUID(), p_evidence_revision: r.identity.evidence_revision }))).toBe("review_required")
    expect((await pending(l.workflowId)).data).toEqual([])
  })

  it("an unresolved intake is held for identity review", async () => {
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Unlinked", phone: phone() }).select("id,phone").single()
    const w = await intake(randomUUID())
    const latest = await inbound(c.data!.id, c.data!.phone)
    expect(refusal(await stage({
      p_shop: shop.shopId, p_workflow: w.workflowId, p_command: randomUUID(), p_revision: 0, p_evidence_revision: 1, p_target: "service", p_question: null,
      p_channel: "sms", p_latest: latest, p_conversation_revision: 0, p_payload: { body: "Fictional", subject: "", destination: c.data!.phone },
    }))).toBe("review_required")
  })

  it("do-not-contact, STOP and a suppressed destination are refused before anything is queued", async () => {
    for (const block of [{ do_not_contact: true }, { sms_opted_out_at: new Date().toISOString() }]) {
      const l = await lead()
      expect((await db.from("customers").update(block).eq("id", l.customerId)).error).toBeNull()
      expect(refusal(await stage(await args(l)))).toBe("contact_blocked")
      expect((await pending(l.workflowId)).data).toEqual([])
    }
    const l = await lead()
    expect((await db.from("customer_channel_permissions").insert({ shop_id: shop.shopId, customer_id: l.customerId, channel: "sms", destination: l.phone, suppressed_at: new Date().toISOString(), suppression_source: "synthetic" })).error).toBeNull()
    expect(refusal(await stage(await args(l)))).toBe("contact_blocked")
  })

  it("no marketing consent is not a staging refusal; the executor still decides at send", async () => {
    const l = await lead()
    expect((await db.from("customer_channel_permissions").select("id").eq("customer_id", l.customerId)).data).toEqual([])
    expect((await stage(await args(l))).error).toBeNull()
  })

  it("an unready channel is refused", async () => {
    const l = await lead(), a = await args(l)
    try {
      await setShop({ twilio_phone_number: null })
      expect(refusal(await stage(a))).toBe("channel_unavailable")
      await setShop({ twilio_phone_number: BUSINESS_NUMBER, byo_sms_verified: false })
      expect(refusal(await stage(a))).toBe("channel_unavailable")
      await setShop({ gradia_number_e164: BUSINESS_NUMBER, a2p_status: "pending" })
      expect(refusal(await stage(a))).toBe("channel_unavailable")
      await setShop({ a2p_status: "approved" })
      expect((await stage(a)).error).toBeNull()
    } finally {
      await setShop({ twilio_phone_number: BUSINESS_NUMBER, gradia_number_e164: null, a2p_status: "unregistered", byo_sms_verified: true })
    }
    // Email needs a connected mailbox; this shop has none.
    const e = await lead()
    const mail = await inbound(e.customerId, e.phone, "email")
    expect(refusal(await stage(await args(e, { p_channel: "email", p_latest: mail, p_payload: { body: "Fictional", subject: "Your request", destination: e.email } })))).toBe("channel_unavailable")
  })

  it("a changed conversation or recipient is refused by the existing Whisper staging", async () => {
    const l = await lead(), a = await args(l)
    await inbound(l.customerId, l.phone)
    expect(refusal(await stage(a))).toBe("conversation_changed")
    const m = await lead(), b = await args(m)
    expect(refusal(await stage({ ...b, p_payload: { ...b.p_payload, destination: phone() } }))).toBe("recipient_changed")
    expect((await db.from("customers").update({ phone: phone() }).eq("id", m.customerId)).error).toBeNull()
    expect(refusal(await stage(b))).toBe("recipient_changed")
    // A lead with no thread on the channel cannot be queued.
    const n = await lead(), c = await args(n)
    expect((await db.from("interactions").delete().eq("id", n.latest)).error).toBeNull()
    expect(refusal(await stage(c))).toBe("conversation_changed")
    expect((await pending(n.workflowId)).data).toEqual([])
  })

  it("only the active owner may queue; delegated and revoked members cannot", async () => {
    const l = await lead(), a = await args(l)
    // Full qualification and message-approval grants are still not permission to queue.
    expect(refusal(await stage(a, manager))).toBe("forbidden")
    expect(refusal(await stage(a, foreignOwner))).toBe("forbidden")
    expect(refusal(await stage({ ...a, p_shop: foreign.shopId }, foreignOwner))).toBe("forbidden")
    expect((await stage(a, anonClient())).error).not.toBeNull()
    expect((await stage(a, db)).error).not.toBeNull()
    expect((await pending(l.workflowId)).data).toEqual([])
    expect((await stage(a)).error).toBeNull()
    // Nobody but the owner can replay the owner's command, even exactly.
    expect(refusal(await stage(a, manager))).toBe("forbidden")
    const member = () => db.from("shop_memberships").update({ active: false }).eq("shop_id", shop.shopId).eq("user_id", other.ownerId)
    try {
      expect((await member()).error).toBeNull()
      expect(refusal(await stage({ ...a, p_command: randomUUID() }, manager))).toBe("forbidden")
    } finally {
      await db.from("shop_memberships").update({ active: true }).eq("shop_id", shop.shopId).eq("user_id", other.ownerId)
    }
    // An owner membership cannot be deactivated (database constraint), so it is not a revocable state.
    expect((await db.from("shop_memberships").update({ active: false }).eq("shop_id", shop.shopId).eq("user_id", shop.ownerId)).error?.code).toBe("23514")
    expect((await stage(a)).data).toMatchObject({ status: "already_queued" })
  })

  it("invalid shapes are refused with a field and queue nothing", async () => {
    const l = await lead(), a = await args(l)
    expect(qualificationQuestionStageRefusal((await stage({ ...a, p_target: "price" })).error!)).toEqual({ ok: false, code: "invalid", field: "target" })
    expect(qualificationQuestionStageRefusal((await stage({ ...a, p_target: "open_question", p_question: null })).error!)).toEqual({ ok: false, code: "invalid", field: "target" })
    expect(qualificationQuestionStageRefusal((await stage({ ...a, p_channel: "voice" })).error!)).toEqual({ ok: false, code: "invalid", field: "channel" })
    expect(qualificationQuestionStageRefusal((await stage({ ...a, p_payload: { ...a.p_payload, body: " " } })).error!)).toEqual({ ok: false, code: "invalid", field: "message" })
    expect(qualificationQuestionStageRefusal((await stage({ ...a, p_payload: { ...a.p_payload, extra: "x" } })).error!)).toEqual({ ok: false, code: "invalid", field: "message" })
    expect((await pending(l.workflowId)).data).toEqual([])
  })

  // Last: an activated policy stays active for this shop.
  it("an Off policy refuses staging with no pending action", async () => {
    const l = await lead(), a = await args(l)
    const d = await owner.from("control_policy_drafts").select("revision").eq("shop_id", shop.shopId).single()
    const saved = await owner.rpc("save_control_policy_draft", { p_shop: shop.shopId, p_expected_revision: d.data!.revision, p_definition: { ...initialPolicyDraft(), workspaceCeiling: "off" } })
    expect(saved.error).toBeNull()
    expect((await owner.rpc("activate_control_policy", { p_shop: shop.shopId, p_revision: saved.data, p_expected_active: null })).error).toBeNull()
    expect(refusal(await stage(a))).toBe("policy_blocked")
    expect((await db.from("pending_actions").select("id").eq("id", a.p_command)).data).toEqual([])
  })
})
