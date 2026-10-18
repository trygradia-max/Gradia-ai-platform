import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { unavailableBrowserCheck } from "@/lib/super-agent/browser"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"

const brief = { name: "Research helper", goal: "Research opportunities for this business", deliverable: "A report for owner review", business_context: "Synthetic business", steps: ["Review the goal"], connections_needed: [], questions: [] }
const detail = unavailableBrowserCheck(false)
describe.skipIf(!INTEGRATION_WITH_SESSION)("digital employee browser check ownership", () => {
  let db: SupabaseClient, owner: SupabaseClient, outsider: SupabaseClient, shop: Seeded, other: Seeded
  const draftId = randomUUID()
  const checkId = randomUUID()
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
      await db.from("super_agent_browser_checks").delete().eq("shop_id", shop.shopId)
      await db.from("super_agent_employee_drafts").delete().eq("shop_id", shop.shopId)
      await cleanup(db, shop)
    }
    if (other) await cleanup(db, other)
  })
  it("lets an owner save an unavailable check and rejects a started session", async () => {
    const saved = await owner.from("super_agent_browser_checks").insert({ id: checkId, shop_id: shop.shopId, draft_id: draftId, status: "unavailable", provider: "none", detail }).select("id,status,provider,detail").single()
    expect(saved.error).toBeNull()
    expect(saved.data).toMatchObject({ id: checkId, status: "unavailable", provider: "none" })
    expect((await owner.from("super_agent_browser_checks").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, status: "ready", provider: "none", detail })).error).not.toBeNull()
    expect((await owner.from("super_agent_browser_checks").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, status: "unavailable", provider: "browserbase", detail })).error).not.toBeNull()
    expect((await owner.from("super_agent_browser_checks").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, status: "unavailable", provider: "none", detail: { ...detail, session_started: true } })).error).not.toBeNull()
  })
  it("hides checks from other shops and anonymous readers and rejects changes", async () => {
    expect((await outsider.from("super_agent_browser_checks").select("*").eq("id", checkId)).data).toEqual([])
    expect((await outsider.from("super_agent_browser_checks").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, status: "unavailable", provider: "none", detail })).error).not.toBeNull()
    expect((await anonClient().from("super_agent_browser_checks").select("*")).error).not.toBeNull()
    expect((await owner.from("super_agent_browser_checks").update({ status: "unavailable" }).eq("id", checkId)).error).not.toBeNull()
    expect((await owner.from("super_agent_browser_checks").delete().eq("id", checkId)).error).not.toBeNull()
    expect((await owner.from("super_agent_browser_checks").insert({ id: checkId, shop_id: shop.shopId, draft_id: draftId, status: "unavailable", provider: "none", detail })).error?.code).toBe("23505")
  })
})
