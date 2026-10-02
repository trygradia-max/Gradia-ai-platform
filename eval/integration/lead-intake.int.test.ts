import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { recordLeadIntake, type LeadIntakeInput } from "@/lib/lead-intake"
import {
  INTEGRATION,
  anonClient,
  cleanup,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PHONE = "+15555550111"

describe.skipIf(!INTEGRATION)("durable lead intake record", () => {
  let db: SupabaseClient
  let db2: SupabaseClient
  let shop: Seeded
  let other: Seeded
  let customerId: string

  function input(overrides: Partial<LeadIntakeInput> = {}): LeadIntakeInput {
    return {
      shopId: shop.shopId,
      channel: "synthetic",
      provider: "synthetic",
      providerEventId: `evt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      receivedAt: "2026-10-01T17:00:00.000Z",
      evidenceRef: "synthetic:fixture",
      threadKey: null,
      payload: { message: "Fictional inquiry" },
      ...overrides,
    }
  }

  async function count(table: string, shopId = shop.shopId): Promise<number> {
    const { count: rows, error } = await db
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shopId)
    expect(error).toBeNull()
    return rows ?? 0
  }

  beforeAll(async () => {
    db = serviceClient()
    db2 = serviceClient()
    shop = await seedShop(db)
    other = await seedShop(db)
    const customer = await db
      .from("customers")
      .insert({
        shop_id: shop.shopId,
        name: "Fictional Existing",
        phone: PHONE,
        email: "existing-intake@example.test",
      })
      .select("id")
      .single()
    expect(customer.error).toBeNull()
    customerId = customer.data!.id
  })

  afterAll(async () => {
    if (shop) await cleanup(db, shop)
    if (other) await cleanup(db, other)
  })

  it("records one envelope and one transition for a duplicate provider event", async () => {
    const delivery = input({
      payload: { message: "Original fictional inquiry", phone: PHONE },
      threadKey: `dup-${Date.now()}`,
    })
    const [first, second] = await Promise.all([
      recordLeadIntake(db, delivery),
      recordLeadIntake(db2, delivery),
    ])
    expect([first.status, second.status].sort()).toEqual(["already_recorded", "recorded"])
    expect(second.envelopeId).toBe(first.envelopeId)
    expect(second.workflowId).toBe(first.workflowId)
    expect(second.transitionId).toBe(first.transitionId)

    const replay = await recordLeadIntake(db2, {
      ...delivery,
      threadKey: "a-different-thread",
      payload: { message: "Replay must not replace evidence", phone: "+15555550999" },
    })
    expect(replay).toMatchObject({
      status: "already_recorded",
      envelopeId: first.envelopeId,
      transitionId: first.transitionId,
      state: "identity_review",
    })

    const envelope = await db
      .from("lead_intake_envelopes")
      .select("payload, thread_key, shop_id")
      .eq("id", first.envelopeId)
      .single()
    expect(envelope.error).toBeNull()
    expect(envelope.data).toEqual({
      payload: { message: "Original fictional inquiry", phone: PHONE },
      thread_key: delivery.threadKey,
      shop_id: shop.shopId,
    })
    expect(
      (await db.from("lead_workflow_transitions").select("id").eq("envelope_id", first.envelopeId)).data,
    ).toHaveLength(1)
    expect(await count("customers")).toBe(1)
    expect(await count("leads")).toBe(0)
    expect(await count("customer_channel_permissions")).toBe(0)
    expect(await count("pending_actions")).toBe(0)
  })

  it("keeps one workflow when an explicit thread arrives out of order and does not infer identity", async () => {
    const threadKey = `thread-${Date.now()}`
    const later = input({
      providerEventId: `later-${threadKey}`,
      receivedAt: "2026-10-01T18:00:00.000Z",
      threadKey,
      payload: { message: "Later fictional message", phone: PHONE, email: "existing-intake@example.test" },
    })
    const earlier = input({
      providerEventId: `earlier-${threadKey}`,
      receivedAt: "2026-10-01T17:00:00.000Z",
      threadKey,
      payload: { message: "Earlier fictional message", phone: PHONE },
    })
    const first = await recordLeadIntake(db, later)
    const second = await recordLeadIntake(db, earlier)
    expect(first.status).toBe("recorded")
    expect(second).toMatchObject({
      status: "recorded",
      workflowId: first.workflowId,
      revision: 2,
      state: "identity_review",
    })

    const workflow = await db.from("lead_workflows").select("*").eq("id", first.workflowId).single()
    expect(workflow.error).toBeNull()
    expect(workflow.data).toMatchObject({
      shop_id: shop.shopId,
      state: "identity_review",
      revision: 2,
      handoff_reason: "identity_unresolved",
      handoff_pending: true,
      thread_key: threadKey,
      last_envelope_id: first.envelopeId,
    })
    expect(workflow.data).not.toHaveProperty("customer_id")
    expect(workflow.data).not.toHaveProperty("lead_id")
    expect(Date.parse(workflow.data!.last_received_at)).toBe(Date.parse(later.receivedAt))

    const transitions = await db
      .from("lead_workflow_transitions")
      .select("revision, from_state, to_state, reason, envelope_id")
      .eq("workflow_id", first.workflowId)
      .order("revision")
    expect(transitions.data).toEqual([
      {
        revision: 1,
        from_state: null,
        to_state: "identity_review",
        reason: "identity_unresolved",
        envelope_id: first.envelopeId,
      },
      {
        revision: 2,
        from_state: "identity_review",
        to_state: "identity_review",
        reason: "additional_evidence",
        envelope_id: second.envelopeId,
      },
    ])

    const unthreaded = await recordLeadIntake(db, input({
      providerEventId: `loose-${threadKey}`,
      receivedAt: "2026-10-01T19:00:00.000Z",
      threadKey: null,
      payload: { message: "Same phone, no thread", phone: PHONE },
    }))
    expect(unthreaded.workflowId).not.toBe(first.workflowId)

    const customer = await db.from("customers").select("name, phone, email").eq("id", customerId).single()
    expect(customer.data).toEqual({
      name: "Fictional Existing",
      phone: PHONE,
      email: "existing-intake@example.test",
    })
    expect(await count("customers")).toBe(1)
    expect(await count("leads")).toBe(0)
    expect(await count("customer_channel_permissions")).toBe(0)
    expect(await count("pending_actions")).toBe(0)
  })

  it("resumes a crash after the row is saved without a second transition or handoff", async () => {
    const delivery = input({
      providerEventId: `crash-${Date.now()}`,
      payload: { message: "Fictional crash fixture" },
    })
    const saved = await recordLeadIntake(db, delivery)
    expect(saved).toMatchObject({ status: "recorded", revision: 1, state: "identity_review" })

    const restarted = serviceClient()
    const visible = await restarted
      .from("lead_intake_envelopes")
      .select("id, workflow_id, shop_id")
      .eq("id", saved.envelopeId)
      .single()
    expect(visible.data).toEqual({
      id: saved.envelopeId,
      workflow_id: saved.workflowId,
      shop_id: shop.shopId,
    })

    const resumed = await recordLeadIntake(restarted, delivery)
    expect(resumed).toEqual({
      status: "already_recorded",
      envelopeId: saved.envelopeId,
      workflowId: saved.workflowId,
      transitionId: saved.transitionId,
      revision: 1,
      state: "identity_review",
    })
    expect(
      (await db.from("lead_workflow_transitions").select("id").eq("workflow_id", saved.workflowId)).data,
    ).toHaveLength(1)
    const workflow = await db
      .from("lead_workflows")
      .select("handoff_pending, state")
      .eq("id", saved.workflowId)
      .single()
    expect(workflow.data).toEqual({ handoff_pending: true, state: "identity_review" })
    expect(
      (await db.from("lead_workflows").update({ handoff_pending: false }).eq("id", saved.workflowId)).error,
    ).not.toBeNull()
    expect(await count("leads")).toBe(0)
    expect(await count("customer_channel_permissions")).toBe(0)
  })

  it("refuses another shop, a consent field, and a direct insert", async () => {
    const delivery = input({ providerEventId: `tenant-${Date.now()}` })
    const saved = await recordLeadIntake(db, delivery)
    await expect(recordLeadIntake(db, { ...delivery, shopId: other.shopId })).rejects.toThrow(
      /another shop/,
    )
    expect(await count("lead_intake_envelopes", other.shopId)).toBe(0)
    expect(
      (await db.from("lead_intake_envelopes").select("id").eq("id", saved.envelopeId)).data,
    ).toHaveLength(1)

    const before = await count("lead_intake_envelopes")
    const rejected = await db.rpc("record_lead_intake", {
      p_shop: shop.shopId,
      p_channel: "synthetic",
      p_provider: "synthetic",
      p_event_id: `consent-${Date.now()}`,
      p_received_at: "2026-10-01T17:30:00.000Z",
      p_evidence_ref: null,
      p_thread_key: null,
      p_payload: { message: "Fictional", marketing_consent: true, customer_id: customerId },
    })
    expect(rejected.error?.code).toBe("22023")
    expect(await count("lead_intake_envelopes")).toBe(before)
    expect(await count("customer_channel_permissions")).toBe(0)

    const inserted = await db.from("lead_intake_envelopes").insert({
      shop_id: shop.shopId,
      channel: "synthetic",
      provider: "synthetic",
      provider_event_id: `direct-${Date.now()}`,
      received_at: "2026-10-01T17:40:00.000Z",
      payload: { message: "no" },
      workflow_id: saved.workflowId,
    })
    expect(inserted.error?.code).toBe("42501")

    const anon = anonClient()
    const anonCall = await anon.rpc("record_lead_intake", {
      p_shop: shop.shopId,
      p_channel: "synthetic",
      p_provider: "synthetic",
      p_event_id: `anon-${Date.now()}`,
      p_received_at: "2026-10-01T17:45:00.000Z",
      p_evidence_ref: null,
      p_thread_key: null,
      p_payload: { message: "Fictional" },
    })
    expect(anonCall.error).not.toBeNull()
    expect(await count("leads")).toBe(0)
  })
})
