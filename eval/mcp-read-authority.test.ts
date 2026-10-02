import { describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { authorizeMcpRead, MCP_READ_REQUIREMENTS } from "@/lib/mcp/read-authority"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
const context = { shopId: "00000000-0000-4000-8000-000000000001", ownerId: "00000000-0000-4000-8000-000000000002", tokenId: "00000000-0000-4000-8000-000000000003" }
function database(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = {
    mcp_tokens: { id: context.tokenId, shop_id: context.shopId, revoked_at: null },
    shops: { id: context.shopId, owner_id: context.ownerId },
    shop_memberships: { shop_id: context.shopId, user_id: context.ownerId, role: "owner", active: true },
    control_policy_active: { shop_id: context.shopId, revision: 2 },
    control_policy_history: { shop_id: context.shopId, revision: 2, definition: initialPolicyDraft() },
    ...overrides,
  }
  const from = vi.fn((table: string) => {
    const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: vi.fn(async () => {
      if (rows[table] instanceof Error) throw rows[table]
      return { data: rows[table], error: null }
    }) }
    return chain
  })
  return { db: { from } as unknown as SupabaseClient, from }
}
describe("MCP read admission", () => {
  it.each(Object.keys(MCP_READ_REQUIREMENTS))("allows baseline read for %s", async capability => {
    expect(await authorizeMcpRead(database().db, context, capability)).toBe(true)
  })
  it("requires token identity and a known capability before lookup", async () => {
    const {db,from}=database()
    expect(await authorizeMcpRead(db,{...context,tokenId:undefined},"crm.read")).toBe(false)
    expect(await authorizeMcpRead(db,context,"unregistered")).toBe(false)
    expect(from).not.toHaveBeenCalled()
  })
  it.each(["mcp_tokens","shops","shop_memberships","control_policy_history"])("fails closed on missing or failed %s", async table => {
    for(const value of [null,new Error("private database failure")]) expect(await authorizeMcpRead(database({[table]:value}).db,context,"recent_customers")).toBe(false)
  })
  it("fails closed on an unavailable active policy lookup", async()=>{
    expect(await authorizeMcpRead(database({control_policy_active:new Error('private')}).db,context,'recent_customers')).toBe(false)
  })
  it("does not activate a saved draft when no policy is active",async()=>{
    const {db,from}=database({control_policy_active:null})
    expect(await authorizeMcpRead(db,context,'recent_customers')).toBe(true)
    expect(from).not.toHaveBeenCalledWith('control_policy_history')
  })
  it.each([
    {mcp_tokens:{id:context.tokenId,shop_id:context.ownerId,revoked_at:null}},
    {mcp_tokens:{id:context.tokenId,shop_id:context.shopId,revoked_at:'2026-10-01'}},
    {shops:{id:context.shopId,owner_id:context.tokenId}},
    {shop_memberships:{shop_id:context.shopId,user_id:context.ownerId,role:'manager',active:true}},
    {shop_memberships:{shop_id:context.shopId,user_id:context.ownerId,role:'owner',active:false}},
    {control_policy_history:{shop_id:context.shopId,revision:1,definition:initialPolicyDraft()}},
    {control_policy_history:{shop_id:context.shopId,revision:2,definition:{}}},
  ])('denies mismatched, stale or malformed authority %#',async overrides=>{
    expect(await authorizeMcpRead(database(overrides).db,context,'recent_customers')).toBe(false)
  })
  it.each([
    {enabled:false},{workspaceDefault:'off'},{workspaceCeiling:'off'},{locationCeiling:'off'},
    {roleCeilings:{owner:'off'}},{connectorCeilings:{crm:'off'}},{actionGrants:{'crm.read':'off'}},
    {riskCeilings:{high:'off'}},{exceptionCeilings:{unknown_identity:'off'}},
  ])('enforces every active ceiling %#',async patch=>{
    const {db}=database({control_policy_history:{shop_id:context.shopId,revision:2,definition:{...initialPolicyDraft(),...patch}}})
    expect(await authorizeMcpRead(db,context,'recent_customers')).toBe(false)
  })
  it('requires both snapshot operations and the additional memory connector',async()=>{
    const {db}=database({control_policy_history:{shop_id:context.shopId,revision:2,definition:{...initialPolicyDraft(),connectorCeilings:{calendar:'off',memory:'off'}}}})
    expect(await authorizeMcpRead(db,context,'shop_snapshot')).toBe(false)
    expect(await authorizeMcpRead(db,context,'search_customer_memory')).toBe(false)
    expect(await authorizeMcpRead(db,context,'search_shop_knowledge')).toBe(false)
    expect(await authorizeMcpRead(db,context,'recent_customers')).toBe(true)
  })
})
