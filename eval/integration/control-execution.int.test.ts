import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { initialPolicyDraft, type PolicyDraft } from "@/lib/control-center/drafts"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, stagePending, type Seeded } from "./_db"

describe.skipIf(!INTEGRATION_WITH_SESSION)("activated policy execution authority", () => {
 let db: SupabaseClient, owner: SupabaseClient, foreignOwner: SupabaseClient
 let shop: Seeded, foreign: Seeded
 const password = "Synthetic-Control-Only-927!"
 let active: number | null = null
 async function publish(definition: PolicyDraft) {
  const current = await owner.from("control_policy_drafts").select("revision").eq("shop_id", shop.shopId).single()
  const save = await owner.rpc("save_control_policy_draft", { p_shop: shop.shopId, p_expected_revision: current.data!.revision, p_definition: definition })
  if (save.error) throw save.error
  const result = await owner.rpc("activate_control_policy", { p_shop: shop.shopId, p_revision: save.data, p_expected_active: active })
  if (result.error) throw result.error
  active = result.data
  return active
 }
 const claim = (id: string, context = "hitl", client = owner, actor?: string) => client.rpc("claim_control_action", { p_shop: shop.shopId, p_action: id, p_actor: actor ?? shop.ownerId, p_context: context })
 const stage = (type = "add_note") => stagePending(db, shop.shopId, shop.ownerId, type, { content: "Fictional note" })
 beforeAll(async () => {
  db = serviceClient(); shop = await seedShop(db, { password }); foreign = await seedShop(db, { password })
  owner = await ownerSessionClient(shop.email, password); foreignOwner = await ownerSessionClient(foreign.email, password)
  await db.from("shops").update({ plan: "active", voice_addon: true }).eq("id", shop.shopId)
 })
 afterAll(async () => { if (shop) await cleanup(db, shop); if (foreign) await cleanup(db, foreign) })
 it("unactivated drafts never enable legacy autonomy; human approval remains usable", async () => {
  const id = await stage()
  expect((await claim(id, "automatic", db)).data).toEqual({ denied: "explicit_activation_required" })
  expect((await claim(id)).data.id).toBe(id)
 })
 it("owner activation is explicit, audited, idempotent and revision bound", async () => {
  await publish(initialPolicyDraft())
  const args = { p_shop: shop.shopId, p_revision: active, p_expected_active: active }
  expect((await owner.rpc("activate_control_policy", args)).data).toBe(active)
  expect((await owner.rpc("activate_control_policy", { ...args, p_expected_active: null })).error?.code).toBe("PT409")
  for (const client of [foreignOwner, anonClient(), db]) expect((await client.rpc("activate_control_policy", args)).error).not.toBeNull()
  const history = await owner.from("control_policy_activations").select("*").eq("shop_id", shop.shopId)
  expect(history.data).toHaveLength(1); expect(history.data![0].actor_id).toBe(shop.ownerId)
 })
 it("saving an Off draft does not disable the active revision", async () => {
  const current = await owner.from("control_policy_drafts").select("revision").eq("shop_id", shop.shopId).single()
  expect((await owner.rpc("save_control_policy_draft", { p_shop: shop.shopId, p_expected_revision: current.data!.revision, p_definition: { ...initialPolicyDraft(), enabled: false } })).error).toBeNull()
  expect((await claim(await stage())).data.id).toBeTruthy()
 })
 it.each(["off", "read", "suggest"] as const)("%s blocks staging and previously staged execution", async mode => {
  await publish(initialPolicyDraft())
  const id = await stage()
  await publish({ ...initialPolicyDraft(), workspaceCeiling: mode })
  const denied = await claim(id)
  expect(denied.data).toEqual({ denied: "execution_not_permitted" })
  expect((await owner.from("pending_actions").select("status").eq("id", id).single()).data?.status).toBe("pending")
  const insert = await db.from("pending_actions").insert({ shop_id: shop.shopId, action_type: "add_note", payload: { content: "No queue" }, requested_by: shop.ownerId })
  expect(insert.error?.code).toBe("42501")
 })
 it("policy is current at claim, with staged/effective versions and payload hash audited", async () => {
  await publish(initialPolicyDraft()); const staged = active, id = await stage()
  await publish({ ...initialPolicyDraft(), connectorCeilings: { crm: "off" } })
  await claim(id)
  const result = await owner.from("control_execution_decisions").select("*").eq("action_id", id).single()
  expect(result.data).toMatchObject({ staged_revision: staged, policy_revision: active, allowed: false, actor_id: shop.ownerId, reason: "execution_not_permitted" })
  expect(result.data!.payload_hash).toMatch(/^[a-f0-9]{64}$/)
 })
 it("only explicit action autonomy can claim automatically and races have one winner", async () => {
  await publish({ ...initialPolicyDraft(), workspaceDefault: "autonomous" })
  const held = await stage()
  expect((await claim(held, "automatic", db)).data.denied).toBe("human_approval_required")
  await publish({ ...initialPolicyDraft(), actionGrants: { "crm.edit": "autonomous" } })
  const id = await stage(); const results = await Promise.all([claim(id, "automatic", db), claim(id, "automatic", db)])
  expect(results.filter(r => r.data?.id === id)).toHaveLength(1)
  expect(results.filter(r => r.data?.already_decided)).toHaveLength(1)
  expect((await claim(id, "automatic", db)).data.already_decided).toBe(true)
 })
 it("session actors cannot forge owner identity, automatic context or cross-shop claims", async () => {
  const id = await stage()
  expect((await claim(id, "hitl", foreignOwner)).data.denied).toBe("actor_not_authorized")
  expect((await claim(id, "automatic", owner)).data.denied).toBe("actor_not_authorized")
  expect((await claim(id, "hitl", db, foreign.ownerId)).data.denied).toBe("actor_not_authorized")
  expect((await claim(id, "invented")).data.denied).toBe("invalid_context")
  expect((await anonClient().rpc("claim_control_action", { p_shop: shop.shopId, p_action: id, p_actor: shop.ownerId, p_context: "hitl" })).error).not.toBeNull()
 })
 it("autonomy preserves entitlements and hard calendar floors", async () => {
  await db.from("shops").update({ voice_addon: false }).eq("id", shop.shopId)
  expect((await claim(await stage(), "automatic", db)).data.denied).toBe("autonomy_entitlement_required")
  await db.from("shops").update({ voice_addon: true }).eq("id", shop.shopId)
  await publish({ ...initialPolicyDraft(), actionGrants: { "booking.create": "autonomous" } })
  expect((await claim(await stage("book_appointment"), "automatic", db)).data.denied).toBe("human_approval_required")
 })
 it.each(["sms", "email"])("unclassified %s cannot select a permissive purpose or escape ceilings", async channel => {
  const definition = { ...initialPolicyDraft(), actionGrants: { [`${channel}.reply`]: "autonomous" } }
  expect((await owner.rpc("control_pending_mode", { p_definition: definition, p_type: `send_${channel}` })).data).toBe("approval")
  definition.actionGrants[`${channel}.followup`] = "off"
  expect((await owner.rpc("control_pending_mode", { p_definition: definition, p_type: `send_${channel}` })).data).toBe("off")
 })
 it("activation and automatic claim serialize against the same shop lock", async () => {
  await publish({ ...initialPolicyDraft(), actionGrants: { "crm.edit": "autonomous" } })
  const id = await stage(), before = active
  const saved = await owner.rpc("save_control_policy_draft", { p_shop: shop.shopId, p_expected_revision: active, p_definition: { ...initialPolicyDraft(), enabled: false } })
  expect(saved.error).toBeNull()
  const [activation, execution] = await Promise.all([
   owner.rpc("activate_control_policy", { p_shop: shop.shopId, p_revision: saved.data, p_expected_active: active }),
   claim(id, "automatic", db),
  ])
  expect(activation.error).toBeNull(); active = activation.data
  const audit = await owner.from("control_execution_decisions").select("*").eq("action_id", id).single()
  expect(audit.error).toBeNull()
  if (execution.data.id) expect(audit.data).toMatchObject({ policy_revision: before, allowed: true })
  else expect(audit.data).toMatchObject({ policy_revision: active, allowed: false, mode: "off" })
  // An in-flight effect cannot be recalled; claim-time is the documented
  // authorization point. Everything claimed after activation must be held.
  expect((await claim(await stagePending(db, foreign.shopId, foreign.ownerId, "add_note", { content: "Foreign" }), "automatic", db)).data.already_decided).toBe(true)
 })
 it("manager and staff membership never imply owner approval authority", async () => {
  await publish(initialPolicyDraft()); const id = await stage()
  const inv = await owner.rpc("team_invite", { p_shop: shop.shopId, p_email: foreign.email, p_role: "manager", p_capabilities: ["crm.read"], p_name: "Fictional manager" })
  expect(inv.error).toBeNull()
  expect((await foreignOwner.rpc("team_accept_invite", { p_token: inv.data.token })).error).toBeNull()
  const member = await db.from("shop_memberships").select("id").eq("shop_id", shop.shopId).eq("user_id", foreign.ownerId).single()
  for (const role of ["manager", "staff"]) {
   const update = await owner.rpc("team_set_member", { p_shop: shop.shopId, p_member: member.data!.id, p_role: role, p_active: true, p_capabilities: [] })
   expect(update.error).toBeNull()
   expect((await claim(id, "hitl", foreignOwner, foreign.ownerId)).data.denied).toBe("actor_not_authorized")
  }
  expect((await owner.rpc("team_set_member", { p_shop: shop.shopId, p_member: member.data!.id, p_role: "staff", p_active: false, p_capabilities: [] })).error).toBeNull()
  expect((await claim(id, "hitl", foreignOwner, foreign.ownerId)).data.denied).toBe("actor_not_authorized")
 })
 it("service clients cannot publish or rewrite active policy snapshots and staging evidence", async () => {
  const id = await stage()
  for (const table of ["control_policy_active", "control_policy_activations", "control_execution_decisions", "control_policy_history"]) {
   expect((await db.from(table).delete().eq("shop_id", shop.shopId)).error?.code).toBe("42501")
  }
  expect((await db.from("pending_actions").update({ control_staged_revision: 999 }).eq("id", id)).error?.code).toBe("42501")
 })
 it("owners cannot mutate activation, activation history or decision audits directly", async () => {
  for (const table of ["control_policy_active", "control_policy_activations", "control_execution_decisions"]) {
   expect((await owner.from(table).delete().eq("shop_id", shop.shopId)).error).not.toBeNull()
   expect((await foreignOwner.from(table).select("*").eq("shop_id", shop.shopId)).data).toEqual([])
  }
 })
})
