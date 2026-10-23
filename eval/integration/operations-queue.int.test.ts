import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { readOperationsQueuePage } from "@/lib/operations-queue-reader"
import { recordLeadIntake } from "@/lib/lead-intake"
import {
  INTEGRATION_WITH_SESSION,
  anonClient,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  stagePending,
  type Seeded,
} from "./_db"

describe.skipIf(!INTEGRATION_WITH_SESSION)("operations queue read authority", () => {
  let db: SupabaseClient, owner: SupabaseClient, manager: SupabaseClient, foreignOwner: SupabaseClient
  let shop: Seeded, managerShop: Seeded, foreign: Seeded, memberId: string
  const password = randomUUID()
  const read = (client: SupabaseClient, patch: Record<string, unknown> = {}) => client.rpc("list_operations_queue", {
    p_shop: shop.shopId, p_before_observed_at: null, p_before_source_kind: null,
    p_before_source_id: null, p_limit: 20, ...patch,
  })

  beforeAll(async () => {
    db = serviceClient()
    shop = await seedShop(db, { password })
    managerShop = await seedShop(db, { password })
    foreign = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password)
    manager = await ownerSessionClient(managerShop.email, password)
    foreignOwner = await ownerSessionClient(foreign.email, password)
    const invitation = await owner.rpc("team_invite", {
      p_shop: shop.shopId, p_email: managerShop.email, p_name: "Fictional operations manager",
      p_role: "manager", p_capabilities: [],
    })
    expect(invitation.error).toBeNull()
    expect((await manager.rpc("team_accept_invite", { p_token: invitation.data.token })).error).toBeNull()
    const membership = await db.from("shop_memberships").select("id").eq("shop_id", shop.shopId).eq("user_id", managerShop.ownerId).single()
    expect(membership.error).toBeNull()
    memberId = membership.data!.id
  })

  afterAll(async () => {
    for (const seed of [shop, managerShop, foreign]) if (seed) await cleanup(db, seed)
  })

  const setMember = (role: string, active: boolean, capabilities: string[]) => owner.rpc("team_set_member", {
    p_shop: shop.shopId, p_member: memberId, p_role: role, p_active: active, p_capabilities: capabilities,
  })

  it("gives the owner bounded tenant-only rows with no payload or proof claims", async () => {
    const own = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", { body: "private owner payload" })
    await stagePending(db, foreign.shopId, foreign.ownerId, "send_sms", { body: "foreign payload" })
    const result = await read(owner)
    expect(result.error).toBeNull()
    expect(result.data.viewer_role).toBe("owner")
    expect(result.data.items.some((item: { source_id: string }) => item.source_id === own)).toBe(true)
    expect(JSON.stringify(result.data)).not.toContain("private owner payload")
    expect(JSON.stringify(result.data)).not.toContain("foreign payload")
    expect(JSON.stringify(result.data)).not.toContain("claims")
  })

  it("filters manager rows by the existing approval and reconciliation grants", async () => {
    const approval = await stagePending(db, shop.shopId, shop.ownerId, "send_sms", { body: "review me" })
    const ownerOnly = await stagePending(db, shop.shopId, shop.ownerId, "book_appointment", { service: "Detail" })
    const uncertain = await stagePending(db, shop.shopId, shop.ownerId, "send_sms", { body: "uncertain" })
    await db.from("pending_actions").update({ status: "approved" }).eq("id", uncertain)
    expect((await db.from("service_proof_consumptions").insert({ proof_id: randomUUID(), shop_id: shop.shopId, action_id: uncertain, claims: { synthetic: true } })).error).toBeNull()

    expect((await read(manager)).error?.code).toBe("42501")
    expect((await setMember("manager", true, ["crm.read", "approvals.messages"])).error).toBeNull()
    const approvals = await read(manager)
    expect(approvals.error).toBeNull()
    expect(approvals.data.items.map((item: { source_id: string }) => item.source_id)).toContain(approval)
    expect(approvals.data.items.map((item: { source_id: string }) => item.source_id)).not.toContain(uncertain)
    expect(approvals.data.items.map((item: { source_id: string }) => item.source_id)).not.toContain(ownerOnly)

    expect((await setMember("manager", true, ["crm.read", "delivery.reconcile"])).error).toBeNull()
    const holds = await read(manager)
    expect(holds.error).toBeNull()
    expect(holds.data.items.map((item: { source_id: string }) => item.source_id)).toContain(uncertain)
    expect(holds.data.items.map((item: { source_id: string }) => item.source_id)).not.toContain(approval)
  })

  it("adds unresolved intake only for owners and managers with the actual CRM read grant", async () => {
    const recorded = await recordLeadIntake(db, {
      shopId: shop.shopId,
      channel: "synthetic",
      provider: "synthetic",
      providerEventId: randomUUID(),
      receivedAt: "2026-10-22T18:00:00Z",
      evidenceRef: "private-evidence-ref",
      threadKey: null,
      payload: { display_name: "Fictional inquiry", message: "Private inquiry text" },
    })
    const ownerResult = await readOperationsQueuePage(owner, shop.shopId)
    expect(ownerResult.status).toBe("ready")
    if (ownerResult.status === "ready") {
      expect(ownerResult.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          workKey: `lead_workflow:${recorded.workflowId}`,
          sources: [expect.objectContaining({ kind: "intake_workflow", id: recorded.workflowId })],
        }),
      ]))
      expect(JSON.stringify(ownerResult)).not.toContain("Private inquiry text")
      expect(JSON.stringify(ownerResult)).not.toContain("private-evidence-ref")
    }

    expect((await setMember("manager", true, ["crm.read"])).error).toBeNull()
    const managerResult = await readOperationsQueuePage(manager, shop.shopId)
    expect(managerResult.status).toBe("ready")
    if (managerResult.status === "ready") {
      expect(managerResult.items.some((item) => item.workKey === `lead_workflow:${recorded.workflowId}`)).toBe(true)
      expect(managerResult.items.every((item) => item.sources.every((source) => source.kind === "intake_workflow"))).toBe(true)
    }
  })

  it("denies staff, revoked members, foreign owners, anonymous users, and the sessionless service role", async () => {
    expect((await setMember("staff", true, [])).error).toBeNull()
    expect((await read(manager)).error?.code).toBe("42501")
    expect((await setMember("manager", false, ["crm.read", "delivery.reconcile"])).error).toBeNull()
    for (const client of [manager, foreignOwner, anonClient(), db]) {
      expect((await read(client)).error?.code).toBe("42501")
    }
  })

  it("uses stable keyset pagination and treats invalid or malformed reads as unavailable", async () => {
    expect((await setMember("manager", true, ["crm.read", "approvals.messages"])).error).toBeNull()
    for (let index = 0; index < 3; index++) {
      await stagePending(db, shop.shopId, shop.ownerId, "send_email", { body: `page-${index}` })
    }
    const first = await readOperationsQueuePage(owner, shop.shopId, { limit: 2 })
    expect(first.status).toBe("ready")
    if (first.status !== "ready") return
    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).not.toBeNull()
    const second = await readOperationsQueuePage(owner, shop.shopId, { limit: 2, cursor: first.nextCursor })
    expect(second.status).toBe("ready")
    if (second.status === "ready") {
      const firstSources = new Set(first.items.flatMap((item) => item.sources.map((source) => `${source.kind}:${source.id}`)))
      expect(second.items.flatMap((item) => item.sources).some((source) => firstSources.has(`${source.kind}:${source.id}`))).toBe(false)
    }
    expect((await readOperationsQueuePage(foreignOwner, shop.shopId)).status).toBe("unavailable")
    const malformed = { rpc: async () => ({ data: { viewer_role: "owner", items: [{ shop_id: shop.shopId }] }, error: null }) } as never
    expect((await readOperationsQueuePage(malformed, shop.shopId)).status).toBe("unavailable")
  })

  it("keeps equal-time mixed sources stable across page boundaries", async () => {
    // Keep this pair ahead of rows staged by earlier tests. A fixed timestamp
    // makes the assertion expire as soon as the suite runs after that date.
    const observedAt = new Date(Date.now() + 60_000).toISOString()
    const action = await stagePending(db, shop.shopId, shop.ownerId, "send_email", { body: "same-time" })
    expect((await db.from("pending_actions").update({ created_at: observedAt }).eq("id", action)).error).toBeNull()
    const recorded = await recordLeadIntake(db, {
      shopId: shop.shopId,
      channel: "synthetic",
      provider: "synthetic",
      providerEventId: randomUUID(),
      receivedAt: observedAt,
      evidenceRef: null,
      threadKey: null,
      payload: { message: "Same-time intake" },
    })
    const first = await readOperationsQueuePage(owner, shop.shopId, { limit: 1 })
    expect(first.status).toBe("ready")
    if (first.status !== "ready") return
    expect(first.items[0].sources[0]).toMatchObject({ kind: "pending_action", id: action })
    const second = await readOperationsQueuePage(owner, shop.shopId, { limit: 1, cursor: first.nextCursor })
    expect(second.status).toBe("ready")
    if (second.status === "ready") {
      expect(second.items[0].sources[0]).toMatchObject({ kind: "intake_workflow", id: recorded.workflowId })
    }
  })

  it("keeps conflict evidence visible without changing source records", async () => {
    const action = await stagePending(db, shop.shopId, shop.ownerId, "send_sms", { body: "conflict" })
    await db.from("pending_actions").update({ status: "approved", result_id: randomUUID() }).eq("id", action)
    expect((await db.from("service_proof_consumptions").insert({ proof_id: randomUUID(), shop_id: shop.shopId, action_id: action, claims: { synthetic: true }, completed_at: new Date().toISOString() })).error).toBeNull()
    expect((await db.from("interactions").insert({ shop_id: shop.shopId, channel: "sms", role: "gradia", content: "Fictional", metadata: { pending_action_id: action, twilio_status: "delivered", twilio_status_conflict: { status: "failed", received_at: new Date().toISOString() } } })).error).toBeNull()
    const projected = await readOperationsQueuePage(owner, shop.shopId)
    expect(projected.status).toBe("ready")
    if (projected.status === "ready") {
      expect(projected.items.find((item) => item.sources.some((source) => source.id === action))?.state).toBe("outcome_unconfirmed")
    }
    const source = await db.from("pending_actions").select("status,result_id").eq("id", action).single()
    expect(source.data).toMatchObject({ status: "approved" })
  })

  it("does not let completed sends consume a queue page", async () => {
    const action = await stagePending(db, shop.shopId, shop.ownerId, "send_sms", { body: "completed" })
    await db.from("pending_actions").update({ status: "approved", result_id: randomUUID() }).eq("id", action)
    expect((await db.from("service_proof_consumptions").insert({
      proof_id: randomUUID(), shop_id: shop.shopId, action_id: action,
      claims: { synthetic: true }, completed_at: new Date().toISOString(),
    })).error).toBeNull()
    const result = await read(owner, { p_limit: 50 })
    expect(result.error).toBeNull()
    expect(result.data.items.some((item: { source_id: string }) => item.source_id === action)).toBe(false)
  })
})
