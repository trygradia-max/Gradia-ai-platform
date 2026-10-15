import { MCP_CAPABILITIES } from "@/lib/mcp/capabilities"
import { randomUUID } from "node:crypto"
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,anonClient,seedShop,cleanup,type Seeded } from "./_db"
import { initialPolicyDraft } from "@/lib/control-center/drafts"
vi.mock("@/lib/embeddings",()=>({embedText:vi.fn().mockResolvedValue(null),EMBEDDING_MODEL:"synthetic-no-provider"}))
vi.mock("@/lib/crm-provider",()=>({pushLeadToCrm:vi.fn(),pushBookingToCrm:vi.fn()}))
import { executeApproval } from "@/lib/approvals"
describe.skipIf(!INTEGRATION_WITH_SESSION)("durable Agent capture staging",()=>{
 let db:SupabaseClient, owner:SupabaseClient, foreignOwner:SupabaseClient,shop:Seeded,foreign:Seeded,token:string
 let active:number|null=null
 const payload={content:"Synthetic note",customer_name:null,phone:null}
 const args=(extra:Record<string,unknown>={})=>({p_shop:shop.shopId,p_actor:shop.ownerId,p_command:randomUUID(),p_type:"add_note",p_payload:payload,p_source:"owner_agent",p_token:null,...extra})
 async function publish(mode:"off"|"read"|"suggest"|"approval") {
  const d=await owner.from("control_policy_drafts").select("revision").eq("shop_id",shop.shopId).single()
  const save=await owner.rpc("save_control_policy_draft",{p_shop:shop.shopId,p_expected_revision:d.data!.revision,p_definition:{...initialPolicyDraft(),workspaceCeiling:mode}})
  expect(save.error).toBeNull()
  const r=await owner.rpc("activate_control_policy",{p_shop:shop.shopId,p_revision:save.data,p_expected_active:active});expect(r.error).toBeNull();active=r.data
 }
 beforeAll(async()=>{
  db=serviceClient();shop=await seedShop(db,{password:"Synthetic-Capture-927!"});foreign=await seedShop(db,{password:"Synthetic-Capture-927!"})
  owner=await ownerSessionClient(shop.email,"Synthetic-Capture-927!");foreignOwner=await ownerSessionClient(foreign.email,"Synthetic-Capture-927!")
  token=randomUUID();expect((await db.from("mcp_tokens").insert({id:token,shop_id:shop.shopId,name:"Synthetic token",capabilities:[...MCP_CAPABILITIES],token_hash:randomUUID()})).error).toBeNull()
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(foreign)await cleanup(db,foreign)})
 it("unactivated capture creates only an attributed pending action, no domain records",async()=>{
  const a=args(),r=await owner.rpc("stage_agent_capture",a);expect(r.error).toBeNull();expect(r.data).toBe(a.p_command)
  const row=await db.from("pending_actions").select("*").eq("id",r.data).single()
  expect(row.data).toMatchObject({status:"pending",requested_by:shop.ownerId,control_staged_revision:null,payload:{source:"owner_agent",mcp_token_id:null}})
  for(const table of ["customers","leads","vehicles","interactions"])expect((await db.from(table).select("id").eq("shop_id",shop.shopId)).data).toEqual([])
 })
 it("concurrent retries create one proposal; changed payload cannot reuse its identity",async()=>{
  const a=args(),r=await Promise.all([owner.rpc("stage_agent_capture",a),owner.rpc("stage_agent_capture",a)])
  for(const x of r){expect(x.error).toBeNull();expect(x.data).toBe(a.p_command)}
  expect((await db.from("pending_actions").select("id").eq("id",a.p_command)).data).toHaveLength(1)
  expect((await owner.rpc("stage_agent_capture",{...a,p_payload:{...payload,content:"Changed"}})).error?.code).toBe("PT409")
 })
 it("anonymous, foreign owner, forged actor and unknown action are denied",async()=>{
  expect((await anonClient().rpc("stage_agent_capture",args())).error).not.toBeNull()
  expect((await foreignOwner.rpc("stage_agent_capture",args())).error?.code).toBe("42501")
  expect((await db.rpc("stage_agent_capture",args({p_actor:foreign.ownerId}))).error?.code).toBe("42501")
  expect((await owner.rpc("stage_agent_capture",args({p_type:"send_sms"}))).error?.code).toBe("42501")
 })
 it.each(["off","read","suggest"] as const)("%s refuses executable staging without a domain effect",async mode=>{
  await publish(mode);const a=args();expect((await owner.rpc("stage_agent_capture",a)).error?.code).toBe("42501")
  expect((await db.from("pending_actions").select("id").eq("id",a.p_command)).data).toEqual([])
 })
 it("approval staging stamps the active revision and does not execute",async()=>{
  await publish("approval");const a=args();expect((await owner.rpc("stage_agent_capture",a)).error).toBeNull()
  expect((await db.from("pending_actions").select("status,control_staged_revision").eq("id",a.p_command).single()).data).toEqual({status:"pending",control_staged_revision:active})
 })
 it("queued captures execute only through owner approval, with replay-safe completion",async()=>{
  const a=args();expect((await owner.rpc("stage_agent_capture",a)).error).toBeNull()
  expect((await executeApproval(db,a.p_command,shop.shopId,{userId:shop.ownerId},{context:"automatic"})).ok).toBe(false)
  expect((await db.from("interactions").select("id").eq("shop_id",shop.shopId)).data).toEqual([])
  const done=await executeApproval(db,a.p_command,shop.shopId,{userId:shop.ownerId})
  expect(done).toMatchObject({ok:true,status:"executed",actionType:"add_note"})
  expect(await executeApproval(db,a.p_command,shop.shopId,{userId:shop.ownerId})).toMatchObject({ok:true,status:"already_decided"})
  expect((await db.from("interactions").select("id").eq("shop_id",shop.shopId)).data).toHaveLength(1)
  const lead=args({p_type:"create_lead",p_payload:{customer_name:"Fictional Lead",phone:"+15555550189",car_info:null,pin_notes:null,status:"new"}})
  expect((await owner.rpc("stage_agent_capture",lead)).error).toBeNull()
  expect((await db.from("leads").select("id").eq("shop_id",shop.shopId)).data).toEqual([])
  expect(await executeApproval(db,lead.p_command,shop.shopId,{userId:shop.ownerId})).toMatchObject({ok:true,status:"executed",actionType:"create_lead"})
  expect((await db.from("leads").select("id").eq("shop_id",shop.shopId)).data).toHaveLength(1)
 })
 it("MCP requires a live same-shop token; attribution cannot be supplied by tool payload",async()=>{
  const a=args({p_source:"mcp",p_token:token,p_type:"create_lead",p_payload:{customer_name:"Fictional",phone:"+15555550189",car_info:null,pin_notes:null,status:"new",source:"forged",mcp_token_id:randomUUID()}})
  expect((await db.rpc("stage_agent_capture",a)).error).toBeNull()
  expect((await db.from("pending_actions").select("payload").eq("id",a.p_command).single()).data?.payload).toMatchObject({source:"mcp",mcp_token_id:token})
  expect((await db.rpc("stage_agent_capture",args({p_source:"mcp",p_token:randomUUID()}))).error?.code).toBe("42501")
  expect((await db.rpc("stage_agent_capture",args({p_source:"mcp",p_token:token,p_shop:foreign.shopId,p_actor:foreign.ownerId}))).error?.code).toBe("42501")
  expect((await owner.rpc("stage_agent_capture",a)).error?.code).toBe("42501")
  await db.from("mcp_tokens").update({revoked_at:new Date().toISOString()}).eq("id",token)
  expect((await db.rpc("stage_agent_capture",a)).error?.code).toBe("42501")
 })
 it("Shadow Mode blocks service staging and the owner membership cannot be silently revoked",async()=>{
  await db.from("shops").update({simulation_mode:true}).eq("id",shop.shopId)
  expect((await db.rpc("stage_agent_capture",args())).error?.code).toBe("42501")
  await db.from("shops").update({simulation_mode:false}).eq("id",shop.shopId)
  const revoke=await db.from("shop_memberships").update({active:false}).eq("shop_id",shop.shopId).eq("user_id",shop.ownerId)
  expect(revoke.error).not.toBeNull()
  expect((await db.from("shop_memberships").select("active").eq("shop_id",shop.shopId).eq("user_id",shop.ownerId).single()).data?.active).toBe(true)
 })
})
