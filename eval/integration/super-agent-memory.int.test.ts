import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { memorySnapshot } from "@/lib/super-agent/memory"
import { INTEGRATION_WITH_SESSION, serviceClient, ownerSessionClient, anonClient, seedShop, cleanup, type Seeded } from "./_db"

const brief = { name: "Research helper", goal: "Research opportunities for this business", deliverable: "A report for owner review", business_context: "Synthetic business", steps: ["Review the goal"], connections_needed: [], questions: [] }
const detail = memorySnapshot([{ source_name: "Hours", content: "Open at 9." }])
describe.skipIf(!INTEGRATION_WITH_SESSION)("digital employee memory read ownership", () => {
  let db: SupabaseClient, owner: SupabaseClient, outsider: SupabaseClient, shop: Seeded, other: Seeded
  const draftId = randomUUID()
  const readId = randomUUID()
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
      await db.from("super_agent_memory_reads").delete().eq("shop_id", shop.shopId)
      await db.from("super_agent_employee_drafts").delete().eq("shop_id", shop.shopId)
      await cleanup(db, shop)
    }
    if (other) await cleanup(db, other)
  })
  it("lets an owner save an unpublished read and rejects a published lesson", async () => {
    const saved = await owner.from("super_agent_memory_reads").insert({ id: readId, shop_id: shop.shopId, draft_id: draftId, detail }).select("id,detail").single()
    expect(saved.error).toBeNull()
    expect(saved.data?.detail).toMatchObject({ published: false, research_included: false })
    expect((await owner.from("super_agent_memory_reads").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, detail: { ...detail, published: true } })).error).not.toBeNull()
    expect((await owner.from("super_agent_memory_reads").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, detail: { ...detail, research_included: true } })).error).not.toBeNull()
  })
  it("hides reads from other shops and anonymous readers and rejects changes", async () => {
    expect((await outsider.from("super_agent_memory_reads").select("*").eq("id", readId)).data).toEqual([])
    expect((await outsider.from("super_agent_memory_reads").insert({ id: randomUUID(), shop_id: shop.shopId, draft_id: draftId, detail })).error).not.toBeNull()
    expect((await anonClient().from("super_agent_memory_reads").select("*")).error).not.toBeNull()
    expect((await owner.from("super_agent_memory_reads").update({ detail }).eq("id", readId)).error).not.toBeNull()
    expect((await owner.from("super_agent_memory_reads").delete().eq("id", readId)).error).not.toBeNull()
    expect((await owner.from("super_agent_memory_reads").insert({ id: readId, shop_id: shop.shopId, draft_id: draftId, detail })).error?.code).toBe("23505")
  })
})
