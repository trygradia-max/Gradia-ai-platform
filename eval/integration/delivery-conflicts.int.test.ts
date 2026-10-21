import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, seedShop, anonClient, cleanup, type Seeded } from "./_db"
import { deliveryConflictSchema, deliveryConflictsSchema } from "@/lib/delivery-reconciliation"

// Operator-visible terminal delivery conflicts (migration 20261021110000) on
// the existing delivery-review authority: owner, or a manager explicitly
// granted crm.read + delivery.reconcile. Real Postgres, real sessions.

describe.skipIf(!INTEGRATION_WITH_SESSION)("delivery conflict review", () => {
  let db: SupabaseClient, owner: SupabaseClient, manager: SupabaseClient, readOnly: SupabaseClient, foreign: SupabaseClient
  let shop: Seeded, mgr: Seeded, ro: Seeded, other: Seeded
  const password = randomUUID()

  beforeAll(async () => {
    db = serviceClient()
    shop = await seedShop(db, { password }); mgr = await seedShop(db, { password }); ro = await seedShop(db, { password }); other = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password)
    manager = await ownerSessionClient(mgr.email, password)
    readOnly = await ownerSessionClient(ro.email, password)
    foreign = await ownerSessionClient(other.email, password)
    for (const [who, client, caps] of [[mgr, manager, ["crm.read", "delivery.reconcile"]], [ro, readOnly, ["crm.read"]]] as const) {
      const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: who.email, p_name: "Fictional Manager", p_role: "manager", p_capabilities: caps })
      expect(invite.error).toBeNull()
      expect((await client.rpc("team_accept_invite", { p_token: invite.data.token })).error).toBeNull()
    }
  })
  afterAll(async () => { for (const s of [shop, mgr, ro, other]) if (s) await cleanup(db, s) })

  /** An outbound text whose callbacks contradicted each other (as #99 records it). */
  async function conflicted(recorded = "delivered", conflict = { status: "failed", error_code: "30008" }) {
    const c = await db.from("customers").insert({ shop_id: shop.shopId, name: "Fictional Customer", phone: "+1555" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0") }).select("id").single()
    expect(c.error).toBeNull()
    const at = new Date().toISOString()
    const i = await db.from("interactions").insert({
      shop_id: shop.shopId, customer_id: c.data!.id, channel: "sms", role: "gradia", content: "Fictional confirmation text",
      metadata: { direction: "outbound", twilio_message_sid: "SM" + randomUUID().replace(/-/g, ""), twilio_status: recorded,
        twilio_status_conflict: { ...conflict, received_at: at } },
    }).select("id, metadata").single()
    expect(i.error).toBeNull()
    return { id: i.data!.id as string, at, metadata: i.data!.metadata }
  }
  const list = (client = owner) => client.rpc("list_delivery_conflicts", { p_shop: shop.shopId, p_offset: 0 })
  const read = (id: string, client = owner) => client.rpc("read_delivery_conflict", { p_shop: shop.shopId, p_interaction: id, p_offset: 0 })
  const resolve = (id: string, at: string, over: Record<string, unknown> = {}, client = owner) =>
    client.rpc("record_delivery_conflict_resolution", { p_shop: shop.shopId, p_interaction: id, p_command: randomUUID(), p_revision: 0,
      p_conflict_received_at: at, p_outcome: "not_delivered", p_note: "Checked the carrier log: undelivered.", ...over })

  it("a contradicted message reads as conflicting and unresolved, never as delivered", async () => {
    const m = await conflicted()
    const r = await list(); expect(r.error).toBeNull()
    const parsed = deliveryConflictsSchema.parse(r.data)
    const item = parsed.items.find((x) => x.interaction_id === m.id)!
    expect(item).toMatchObject({ delivery_state: "conflicting", resolution_state: "unresolved", recorded_status: "delivered", conflict_status: "failed", conflict_error_code: "30008", customer_name: "Fictional Customer", review_revision: 0 })
    expect(parsed.viewer_role).toBe("owner")
  })

  it("a resolution is audited with actor, role, scope and reason, and the evidence is kept untouched", async () => {
    const m = await conflicted()
    const command = randomUUID()
    expect((await resolve(m.id, m.at, { p_command: command })).data).toBe(command)
    const r = deliveryConflictSchema.parse((await read(m.id)).data)
    expect(r.resolution_state).toBe("resolved")
    expect(r.delivery_state).toBe("conflicting") // still not an unqualified success
    expect(r.history[0]).toMatchObject({ command_id: command, revision: 1, actor_id: shop.ownerId, actor_role: "owner", outcome: "not_delivered",
      note: "Checked the carrier log: undelivered.", reviewed_status: "delivered", reviewed_conflict_status: "failed", reviewed_conflict_error_code: "30008", reviewed_conflict_received_at: m.at })
    expect((await db.from("interactions").select("metadata").eq("id", m.id).single()).data!.metadata).toEqual(m.metadata)
    // The same command replays as itself; reusing it with a changed note is refused.
    expect((await resolve(m.id, m.at, { p_command: command })).data).toBe(command)
    expect((await resolve(m.id, m.at, { p_command: command, p_note: "A different note entirely." })).error?.code).toBe("PT409")
  })

  it("a newer conflicting callback reopens a resolved message, and a stale review is refused", async () => {
    const m = await conflicted()
    expect((await resolve(m.id, m.at)).error).toBeNull()
    const newer = new Date(Date.now() + 1000).toISOString()
    expect((await db.from("interactions").update({ metadata: { ...m.metadata, twilio_status_conflict: { status: "undelivered", error_code: "30003", received_at: newer } } }).eq("id", m.id)).error).toBeNull()
    expect(deliveryConflictSchema.parse((await read(m.id)).data).resolution_state).toBe("unresolved")
    expect((await resolve(m.id, m.at, { p_revision: 1 })).error?.code).toBe("PT409") // reviewed the old conflict
    expect((await resolve(m.id, newer, { p_revision: 0 })).error?.code).toBe("PT409") // stale history
    expect((await resolve(m.id, newer, { p_revision: 1 })).error).toBeNull()
  })

  it("a delegated manager with delivery.reconcile can read and resolve, attributed as manager", async () => {
    const m = await conflicted()
    expect(deliveryConflictsSchema.parse((await list(manager)).data).viewer_role).toBe("manager")
    expect((await resolve(m.id, m.at, {}, manager)).error).toBeNull()
    expect(deliveryConflictSchema.parse((await read(m.id)).data).history[0]).toMatchObject({ actor_id: mgr.ownerId, actor_role: "manager" })
  })

  it("denies a manager without the grant, another shop's owner, anonymous and sessionless service callers", async () => {
    const m = await conflicted()
    for (const client of [readOnly, foreign, anonClient(), db]) {
      expect((await list(client)).error).not.toBeNull()
      expect((await read(m.id, client)).error).not.toBeNull()
      expect((await resolve(m.id, m.at, {}, client)).error).not.toBeNull()
    }
    expect(deliveryConflictSchema.parse((await read(m.id)).data).review_revision).toBe(0)
  })

  it("a revoked or deactivated manager is refused at once", async () => {
    const m = await conflicted()
    expect((await db.from("shop_memberships").update({ active: false }).eq("shop_id", shop.shopId).eq("user_id", mgr.ownerId)).error).toBeNull()
    try {
      expect((await list(manager)).error).not.toBeNull()
      expect((await resolve(m.id, m.at, {}, manager)).error).not.toBeNull()
    } finally {
      expect((await db.from("shop_memberships").update({ active: true }).eq("shop_id", shop.shopId).eq("user_id", mgr.ownerId)).error).toBeNull()
    }
  })

  it("concurrent resolutions of the same conflict have one winner", async () => {
    const m = await conflicted()
    const results = await Promise.all([resolve(m.id, m.at), resolve(m.id, m.at, { p_outcome: "delivered" }, manager)])
    expect(results.filter((r) => !r.error)).toHaveLength(1)
    expect(results.find((r) => r.error)?.error?.code).toBe("PT409")
  })

  it("the audit table can't be read or written directly, even by the service role", async () => {
    const m = await conflicted()
    expect((await resolve(m.id, m.at)).error).toBeNull()
    for (const client of [owner, manager, anonClient(), db]) {
      expect((await client.from("delivery_conflict_resolutions").select("*")).error).not.toBeNull()
      expect((await client.from("delivery_conflict_resolutions").insert({ command_id: randomUUID(), shop_id: shop.shopId, interaction_id: m.id, revision: 9,
        actor_id: shop.ownerId, actor_label: "forged", actor_role: "owner", outcome: "delivered", note: "Forged review evidence",
        reviewed_status: "delivered", reviewed_conflict_status: "failed", reviewed_conflict_received_at: m.at })).error).not.toBeNull()
    }
  })

  it("messages without a conflict, another shop's messages and inbound texts are not listed or resolvable", async () => {
    const plain = await db.from("interactions").insert({ shop_id: shop.shopId, channel: "sms", role: "gradia", content: "Fictional", metadata: { twilio_status: "delivered" } }).select("id").single()
    const inbound = await db.from("interactions").insert({ shop_id: shop.shopId, channel: "sms", role: "customer", content: "Fictional", metadata: { twilio_status_conflict: { status: "failed", received_at: "x" } } }).select("id").single()
    const foreignMsg = await db.from("interactions").insert({ shop_id: other.shopId, channel: "sms", role: "gradia", content: "Fictional", metadata: { twilio_status: "delivered", twilio_status_conflict: { status: "failed", received_at: "x" } } }).select("id").single()
    const ids = deliveryConflictsSchema.parse((await list()).data).items.map((x) => x.interaction_id)
    for (const r of [plain, inbound, foreignMsg]) {
      expect(ids).not.toContain(r.data!.id)
      expect((await read(r.data!.id)).error).not.toBeNull()
      expect((await resolve(r.data!.id, "x")).error).not.toBeNull()
    }
  })
})
