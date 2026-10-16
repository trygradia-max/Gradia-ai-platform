import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"

const brief = { name: "Research helper", goal: "Research opportunities for this business", deliverable: "A report for owner review", business_context: "Synthetic business", steps: ["Review the goal"], connections_needed: [], questions: [] }
describe.skipIf(!INTEGRATION_WITH_SESSION)("digital employee draft ownership", () => {
  let db: SupabaseClient, owner: SupabaseClient, outsider: SupabaseClient, shop: Seeded, other: Seeded
  const id = randomUUID()
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); other = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); outsider = await ownerSessionClient(other.email, password)
  })
  afterAll(async () => {
    if (shop) { await db.from("super_agent_employee_drafts").delete().eq("shop_id", shop.shopId); await cleanup(db, shop) }
    if (other) await cleanup(db, other)
  })
  it("lets an owner persist and read a draft without granting runtime authority", async () => {
    const saved = await owner.from("super_agent_employee_drafts").insert({ id, shop_id: shop.shopId, brief }).select("*").single()
    expect(saved.error).toBeNull()
    expect(saved.data).toMatchObject({ id, brief })
    expect(saved.data).not.toHaveProperty("enabled")
  })
  it("refuses cross-shop creation and hides other shops' briefs", async () => {
    const read = await outsider.from("super_agent_employee_drafts").select("*").eq("id", id)
    expect(read.error).toBeNull(); expect(read.data).toEqual([])
    expect((await outsider.from("super_agent_employee_drafts").insert({ id: randomUUID(), shop_id: shop.shopId, brief })).error).not.toBeNull()
  })
  it("does not expose drafts to anonymous readers", async () => {
    expect((await anonClient().from("super_agent_employee_drafts").select("*")).error).not.toBeNull()
  })
  it("keeps saved briefs immutable and duplicate IDs unique", async () => {
    expect((await owner.from("super_agent_employee_drafts").update({ brief: { ...brief, name: "Changed" } }).eq("id", id)).error).not.toBeNull()
    expect((await owner.from("super_agent_employee_drafts").insert({ id, shop_id: shop.shopId, brief })).error?.code).toBe("23505")
  })
  it("lets the owner save a research report and hides it from other shops", async () => {
    const runId = randomUUID()
    const report = { summary: "Notes for review.", findings: [], rejected_instructions: [], missing_connections: [], approval_status: "waiting_for_review", published: false }
    const saved = await owner.from("super_agent_research_runs").insert({ id: runId, shop_id: shop.shopId, draft_id: id, status: "ready", report }).select("id,status").single()
    expect(saved.error).toBeNull()
    expect((await outsider.from("super_agent_research_runs").select("*").eq("id", runId)).data).toEqual([])
    expect((await owner.from("super_agent_research_runs").update({ status: "blocked" }).eq("id", runId)).error).not.toBeNull()
    await db.from("super_agent_research_runs").delete().eq("id", runId)
  })
})
