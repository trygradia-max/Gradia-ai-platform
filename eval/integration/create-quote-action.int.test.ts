import {afterAll,beforeAll,describe,expect,it,vi} from "vitest"
import {randomUUID} from "node:crypto"
import type {SupabaseClient} from "@supabase/supabase-js"
import {executeApproval} from "@/lib/approvals"
import {initialPolicyDraft} from "@/lib/control-center/drafts"
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,seedShop,cleanup,stagePending,type Seeded} from "./_db"
vi.mock("@/lib/memory",async original=>({...await original<typeof import("@/lib/memory")>(),recordInteraction:vi.fn(async()=>({ok:true as const,id:randomUUID(),embedded:false}))}))

// Regression: `create_quote` was missing from pending_action_type, so the voice
// receptionist's quote proposals could not be queued on a migrated database.
describe.skipIf(!INTEGRATION_WITH_SESSION)("create_quote pending actions",()=>{
 let db:SupabaseClient,owner:SupabaseClient,shop:Seeded
 const proposal=()=>({customer_name:"Fictional Quote Customer",phone:"+1555"+String(Math.floor(Math.random()*1e7)).padStart(7,"0"),car_info:"2021 Tesla Model Y, white",services:["Full Detail"],notes:"Fictional call note",source:"voice",vapi_call_id:null})
 const claim=(id:string,context:string,client:SupabaseClient)=>client.rpc("claim_control_action",{p_shop:shop.shopId,p_action:id,p_actor:shop.ownerId,p_context:context})
 beforeAll(async()=>{
  db=serviceClient();const password=randomUUID();shop=await seedShop(db,{password});owner=await ownerSessionClient(shop.email,password)
  expect((await db.from("shops").update({plan:"active",voice_addon:true}).eq("id",shop.shopId)).error).toBeNull()
 })
 afterAll(async()=>{if(shop)await cleanup(db,shop)})
 it("can be staged exactly as the voice tool stages it",async()=>{
  const id=await stagePending(db,shop.shopId,shop.ownerId,"create_quote",proposal())
  expect((await db.from("pending_actions").select("action_type,status").eq("id",id).single()).data).toEqual({action_type:"create_quote",status:"pending"})
 })
 it("owner approval creates a draft quote priced from the menu, never a sent one",async()=>{
  const id=await stagePending(db,shop.shopId,shop.ownerId,"create_quote",proposal())
  const result=await executeApproval(owner,id,shop.shopId,{userId:shop.ownerId})
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,status:"executed",actionType:"create_quote"})
  const quote=await db.from("quotes").select("id,status,created_by,line_items,sent_at").eq("shop_id",shop.shopId).single()
  expect(quote.error).toBeNull();expect(quote.data).toMatchObject({status:"draft",created_by:"agent",sent_at:null});expect(quote.data!.line_items).toHaveLength(1)
  expect((await db.from("pending_actions").select("status,result_id").eq("id",id).single()).data).toEqual({status:"approved",result_id:quote.data!.id})
 })
 it("stays on the approval floor: no automatic claim, even under a policy that grants autonomy",async()=>{
  const before=await stagePending(db,shop.shopId,shop.ownerId,"create_quote",proposal())
  expect((await claim(before,"automatic",db)).data).toEqual({denied:"explicit_activation_required"})
  const draft=await owner.from("control_policy_drafts").select("revision").eq("shop_id",shop.shopId).single()
  const save=await owner.rpc("save_control_policy_draft",{p_shop:shop.shopId,p_expected_revision:draft.data!.revision,p_definition:{...initialPolicyDraft(),workspaceDefault:"autonomous",actionGrants:{"quote.send":"autonomous","quote.discount":"autonomous"}}});expect(save.error).toBeNull()
  expect((await owner.rpc("activate_control_policy",{p_shop:shop.shopId,p_revision:save.data,p_expected_active:null})).error).toBeNull()
  const id=await stagePending(db,shop.shopId,shop.ownerId,"create_quote",proposal())
  expect((await claim(id,"automatic",db)).data).toEqual({denied:"human_approval_required"})
  expect((await db.from("pending_actions").select("status").eq("id",id).single()).data).toEqual({status:"pending"})
  expect((await claim(id,"hitl",owner)).data.id).toBe(id)
 })
})
