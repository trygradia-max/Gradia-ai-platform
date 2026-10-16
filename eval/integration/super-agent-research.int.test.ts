import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"

const brief = { name: "Research helper", goal: "Research opportunities for this business", deliverable: "A report for owner review", business_context: "Synthetic business", steps: ["Review the goal"], connections_needed: [], questions: [] }
const report = { version: 1, summary: "Fixture result" }
describe.skipIf(!INTEGRATION_WITH_SESSION)("digital employee research ownership", () => {
  let db: SupabaseClient, owner: SupabaseClient, outsider: SupabaseClient, shop: Seeded, other: Seeded
  const draftId = randomUUID()
  const runId = randomUUID()
  beforeAll(async () => {
    db = serviceClient()
    const password = randomUUID()
    shop = await seedShop(db, { password }); other = await seedShop(db, { password })
    owner = await ownerSessionClient(shop.email, password); outsider = await ownerSessionClient(other.email, password)
    const draft = await owner.from("super_agent_employee_drafts").insert({ id: draftId, shop_id: shop.shopId, brief })
    if (draft.error) throw new Error(draft.error.message)
  })
  afterAll(async () => {
    if (shop) {
      await db.from("super_agent_research_cancels").delete().eq("shop_id", shop.shopId)
      await db.from("super_agent_research_runs").delete().eq("shop_id", shop.shopId)
      await db.from("super_agent_employee_drafts").delete().eq("shop_id", shop.shopId)
      await cleanup(db, shop)
    }
    if (other) await cleanup(db, other)
  })
  it("lets an owner save and read a research result", async () => {
    const saved = await owner.from("super_agent_research_runs").insert({ id: runId, shop_id: shop.shopId, draft_id: draftId, status: "completed", report, credits: 0 }).select("id,status,report").single()
    expect(saved.error).toBeNull()
    expect(saved.data).toMatchObject({ id: runId, status: "completed", report })
  })
  it("hides results from other shops and anonymous readers", async () => {
    expect((await outsider.from("super_agent_research_runs").select("*").eq("id", runId)).data).toEqual([])
    expect((await outsider.from("super_agent_research_runs").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, status: "completed", report, credits: 0 })).error).not.toBeNull()
    expect((await anonClient().from("super_agent_research_runs").select("*")).error).not.toBeNull()
  })
  it("rejects changes, deletes, and a repeated run id", async () => {
    expect((await owner.from("super_agent_research_runs").update({ status: "failed" }).eq("id", runId)).error).not.toBeNull()
    expect((await owner.from("super_agent_research_runs").delete().eq("id", runId)).error).not.toBeNull()
    expect((await owner.from("super_agent_research_runs").insert({ id: runId, shop_id: shop.shopId, draft_id: draftId, status: "completed", report, credits: 0 })).error?.code).toBe("23505")
  })
  it("lets the owner record a stop and hides it from other shops", async () => {
    expect((await owner.from("super_agent_research_cancels").insert({ run_id: runId, shop_id: shop.shopId })).error).toBeNull()
    expect((await outsider.from("super_agent_research_cancels").select("*").eq("run_id", runId)).data).toEqual([])
    expect((await outsider.from("super_agent_research_cancels").insert({ run_id: randomUUID(), shop_id: shop.shopId })).error).not.toBeNull()
  })
})
