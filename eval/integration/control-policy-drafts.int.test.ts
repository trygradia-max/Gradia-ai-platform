import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { initialPolicyDraft, type PolicyDraft } from "@/lib/control-center/drafts"
import { ACTIONS, modes } from "@/lib/control-center/policy"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"

describe.skipIf(!INTEGRATION_WITH_SESSION)("policy draft persistence and authority", () => {
  let db: SupabaseClient, owner: SupabaseClient, other: SupabaseClient, staff: SupabaseClient
  let shop: Seeded, foreign: Seeded, staffId: string
  const password = "Synthetic-Policy-Fixture-Only-241!"
  async function current() {
    const r = await owner.from("control_policy_drafts").select("*").eq("shop_id", shop.shopId).single()
    if (r.error) throw r.error
    return r.data
  }
  async function save(client: SupabaseClient, revision: number, definition: unknown, shopId = shop.shopId) {
    return client.rpc("save_control_policy_draft", { p_shop: shopId, p_expected_revision: revision, p_definition: definition })
  }
  beforeAll(async () => {
    db = serviceClient(); shop = await seedShop(db, { password }); foreign = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); other = await ownerSessionClient(foreign.email, password)
    const email = `policy-${crypto.randomUUID()}@example.test`
    const u = await db.auth.admin.createUser({ email, password, email_confirm: true })
    if (u.error || !u.data.user) throw new Error("Synthetic user setup failed")
    staffId = u.data.user.id; staff = await ownerSessionClient(email, password)
    const invite = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: email, p_role: "manager", p_capabilities: ["crm.read"], p_name: "Fictional manager" })
    if (invite.error) throw invite.error
    const accept = await staff.rpc("team_accept_invite", { p_token: invite.data.token })
    if (accept.error) throw accept.error
  })
  afterAll(async () => { if (shop) await cleanup(db, shop); if (foreign) await cleanup(db, foreign); if (staffId) await db.auth.admin.deleteUser(staffId) })
  it("bootstraps one draft and immutable baseline history without activating anything", async () => {
    const row = await current()
    expect(row.revision).toBe(1); expect(row.definition).toEqual(initialPolicyDraft()); expect(row.updated_by).toBe(shop.ownerId)
    const loc = await db.from("shop_locations").select("id").eq("shop_id", shop.shopId).single()
    expect(row.location_id).toBe(loc.data!.id)
    const h = await owner.from("control_policy_history").select("*").eq("shop_id", shop.shopId)
    expect(h.error).toBeNull(); expect(h.data).toHaveLength(1)
  })
  it("owner can save and history captures exact definition and real actor", async () => {
    const row = await current(), definition = { ...row.definition, enabled: false }
    const r = await save(owner, row.revision, definition)
    expect(r.error).toBeNull(); expect(r.data).toBe(2)
    const h = await owner.from("control_policy_history").select("*").eq("shop_id", shop.shopId).eq("revision", 2).single()
    expect(h.data).toMatchObject({ definition, actor_id: shop.ownerId })
  })
  it("same-revision identical save is idempotent; stale revision is rejected", async () => {
    const row = await current()
    expect((await save(owner, row.revision, row.definition)).data).toBe(row.revision)
    const stale = await save(owner, row.revision - 1, row.definition)
    expect(stale.error?.code).toBe("PT409"); expect(stale.status).toBe(409)
    expect((await current()).revision).toBe(row.revision)
  })
  it("concurrent owner sessions have exactly one winning revision", async () => {
    const row = await current()
    const secondSession = await ownerSessionClient(shop.email, password)
    const results = await Promise.all([
      save(owner, row.revision, { ...row.definition, workspaceCeiling: "read" }),
      save(secondSession, row.revision, { ...row.definition, workspaceCeiling: "off" }),
    ])
    expect(results.filter(r => !r.error)).toHaveLength(1)
    expect(results.filter(r => r.error?.code === "PT409")).toHaveLength(1)
    expect((await current()).revision).toBe(row.revision + 1)
  })
  it("manager, foreign owner and anonymous callers cannot read or mutate drafts", async () => {
    const row = await current()
    for (const client of [staff, other, anonClient()]) {
      const r = await client.from("control_policy_drafts").select("*").eq("shop_id", shop.shopId)
      expect(r.data ?? []).toHaveLength(0)
      expect((await save(client, row.revision, initialPolicyDraft())).error).not.toBeNull()
      const h = await client.from("control_policy_history").select("*").eq("shop_id", shop.shopId)
      expect(h.data ?? []).toHaveLength(0)
    }
    expect((await current()).revision).toBe(row.revision)
  })
  it("staff and revoked members cannot gain policy authority with the same session", async () => {
    const membership = await db.from("shop_memberships").select("id").eq("shop_id", shop.shopId).eq("user_id", staffId).single()
    const row = await current()
    for (const active of [true, false]) {
      const changed = await owner.rpc("team_set_member", { p_shop: shop.shopId, p_member: membership.data!.id, p_role: "staff", p_active: active, p_capabilities: [] })
      expect(changed.error).toBeNull()
      expect((await save(staff, row.revision, initialPolicyDraft())).error).not.toBeNull()
      expect((await staff.from("control_policy_drafts").select("*").eq("shop_id", shop.shopId)).data).toEqual([])
    }
  })
  it("owners cannot use direct table writes or rewrite history", async () => {
    const row = await current()
    expect((await owner.from("control_policy_drafts").update({ revision: 999 }).eq("shop_id", shop.shopId)).error).not.toBeNull()
    expect((await owner.from("control_policy_history").delete().eq("shop_id", shop.shopId)).error).not.toBeNull()
    expect((await owner.from("control_policy_history").update({ actor_id: foreign.ownerId }).eq("shop_id", shop.shopId)).error).not.toBeNull()
    expect((await current()).revision).toBe(row.revision)
  })
  it("SQL accepts all supported action/mode combinations and inheritance", async () => {
    for (const mode of modes) {
      const row = await current()
      const d: PolicyDraft = { ...initialPolicyDraft(), actionGrants: Object.fromEntries(Object.keys(ACTIONS).map(op => [op, mode])), connectorCeilings: { sms: null, email: mode } }
      const result = await save(owner, row.revision, d)
      expect(result.error).toBeNull()
      expect((await current()).definition).toEqual(d)
    }
  })
  it("SQL refuses unknown keys/modes/activation and malformed structures atomically", async () => {
    const row = await current()
    for (const definition of [null, {}, [], { ...initialPolicyDraft(), activated: true }, { ...initialPolicyDraft(), enabled: "yes" }, { ...initialPolicyDraft(), workspaceCeiling: null }, { ...initialPolicyDraft(), actionGrants: { unknown: "autonomous" } }, { ...initialPolicyDraft(), actionGrants: { "sms.reply": "custom" } }, { ...initialPolicyDraft(), connectorCeilings: [] }, { ...initialPolicyDraft(), roleCeilings: { admin: "autonomous" } }, { ...initialPolicyDraft(), riskCeilings: { invented: null } }, { ...initialPolicyDraft(), exceptionCeilings: { bypass_consent: "autonomous" } }]) {
      expect((await save(owner, row.revision, definition)).error).not.toBeNull()
    }
    expect((await current()).revision).toBe(row.revision)
  })
  it("foreign location references fail the composite database constraint", async () => {
    const row = await current(), loc = await db.from("shop_locations").select("id").eq("shop_id", foreign.shopId).single()
    expect((await db.from("control_policy_drafts").update({ location_id: loc.data!.id }).eq("shop_id", shop.shopId)).error?.code).toBe("23503")
    expect((await current()).location_id).toBe(row.location_id)
  })
  it("saving disabled drafts does not change existing pending actions or live settings", async () => {
    const before = await db.from("shops").select("settings").eq("id", shop.shopId).single()
    const row = await current()
    expect((await save(owner, row.revision, { ...initialPolicyDraft(), enabled: false })).error).toBeNull()
    const after = await db.from("shops").select("settings").eq("id", shop.shopId).single()
    expect(after.data).toEqual(before.data)
    const p = await db.from("pending_actions").select("id").eq("shop_id", shop.shopId)
    expect(p.data).toEqual([])
  })
})
