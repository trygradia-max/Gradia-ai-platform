import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest"
import {randomUUID} from "node:crypto"
import type {SupabaseClient} from "@supabase/supabase-js"
import {executeApproval} from "@/lib/approvals"
import {sendOutboundSms} from "@/lib/twilio"
import {sendEmailMessage} from "@/lib/aurinko"
import {initialPolicyDraft,type PolicyDraft} from "@/lib/control-center/drafts"
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,seedShop,anonClient,cleanup,stagePending,type Seeded} from "./_db"
vi.mock("@/lib/telephony-provider",async original=>({...await original<typeof import("@/lib/telephony-provider")>(),smsGateForShop:()=>({allowed:true})}))
vi.mock("@/lib/twilio",async original=>({...await original<typeof import("@/lib/twilio")>(),sendOutboundSms:vi.fn(async()=>({messageSid:"synthetic-message",status:"queued"}))}))
vi.mock("@/lib/aurinko",async original=>({...await original<typeof import("@/lib/aurinko")>(),getAccessTokenForShop:vi.fn(async()=>"synthetic-token"),sendEmailMessage:vi.fn(async()=>({id:"synthetic-email"}))}))
vi.mock("@/lib/memory",async original=>({...await original<typeof import("@/lib/memory")>(),recordInteraction:vi.fn(async()=>({ok:true as const,id:randomUUID(),embedded:false}))}))
vi.mock("@/lib/credits",()=>({recordUsage:vi.fn()}))
vi.mock("@/lib/pricing",async original=>({...await original<typeof import("@/lib/pricing")>(),getPricing:vi.fn(),priceUsage:()=>({credits:0,wholesale_cost:0,retail_cost:0})}))
import {reviewCommunicationPurpose} from "@/app/actions/approvals"
let owner:SupabaseClient,shop:Seeded
vi.mock("@/lib/shop",()=>({requireUser:async()=>({id:shop.ownerId}),requireShop:async()=>({id:shop.shopId})}))
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>owner}))
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}))

describe.skipIf(!INTEGRATION_WITH_SESSION)("Delegated manager message approval",()=>{
 let db:SupabaseClient,manager:SupabaseClient,other:Seeded,active:number|null=null
 const delegated=["crm.read","approvals.messages"]
 const grant=(capabilities:string[],role="manager",isActive=true)=>db.from("shop_memberships").update({active:isActive,role,capabilities}).eq("shop_id",shop.shopId).eq("user_id",other.ownerId)
 const hash=async(id:string)=>{const page=await owner.rpc("list_delegated_message_approvals",{p_shop:shop.shopId,p_offset:0});expect(page.error).toBeNull();return page.data.items.find((x:{action_id:string})=>x.action_id===id)?.review_hash as string}
 const claim=(id:string,expected:string|null,client=manager,shopId=shop.shopId)=>client.rpc("claim_delegated_message",{p_shop:shopId,p_action:id,p_expected:expected})
 const status=async(id:string)=>(await db.from("pending_actions").select("status,decided_by_user,result_id").eq("id",id).single()).data
 const decisions=async(id:string)=>(await db.from("control_execution_decisions").select("actor_id,actor_role,allowed,reason,mode,context").eq("action_id",id).order("id")).data
 const message=(body="Fictional queued text")=>stagePending(db,shop.shopId,shop.ownerId,"send_sms",{to_phone:"+15555550123",body,category:"marketing"})
 async function publish(definition:PolicyDraft){
  const current=await owner.from("control_policy_drafts").select("revision").eq("shop_id",shop.shopId).single()
  const save=await owner.rpc("save_control_policy_draft",{p_shop:shop.shopId,p_expected_revision:current.data!.revision,p_definition:definition});if(save.error)throw save.error
  const result=await owner.rpc("activate_control_policy",{p_shop:shop.shopId,p_revision:save.data,p_expected_active:active});if(result.error)throw result.error
  active=result.data
 }
 beforeAll(async()=>{
  db=serviceClient();const password=randomUUID();shop=await seedShop(db,{password});other=await seedShop(db,{password})
  owner=await ownerSessionClient(shop.email,password);manager=await ownerSessionClient(other.email,password)
  expect((await db.from("shops").update({aurinko_account_id:987654,quiet_hours_start:0,quiet_hours_end:0,twilio_phone_number:"+15550001111"}).eq("id",shop.shopId)).error).toBeNull()
  const invite=await owner.rpc("team_invite",{p_shop:shop.shopId,p_email:other.email,p_name:"Fictional Manager",p_role:"manager",p_capabilities:delegated});expect(invite.error).toBeNull()
  expect((await manager.rpc("team_accept_invite",{p_token:invite.data.token})).error).toBeNull()
 })
 afterEach(()=>vi.clearAllMocks())
 afterAll(async()=>{if(shop)await cleanup(db,shop);if(other)await cleanup(db,other)})

 it("claims exactly the reviewed message and audits the manager as the decider",async()=>{
  const id=await message(),reviewed=await hash(id);expect(reviewed).toMatch(/^[0-9a-f]{64}$/)
  const result=await claim(id,reviewed);expect(result.error).toBeNull();expect(result.data).toMatchObject({id,shop_id:shop.shopId,action_type:"send_sms"})
  expect(await status(id)).toEqual({status:"approved",decided_by_user:other.ownerId,result_id:null})
  expect(await decisions(id)).toEqual([{actor_id:other.ownerId,actor_role:"manager",allowed:true,reason:"current_policy_authorized",mode:"approval",context:"hitl"}])
  expect((await claim(id,reviewed)).data).toEqual({already_decided:true});expect(await decisions(id)).toHaveLength(1)
 })
 it("refuses a missing, malformed, stale or mid-edit review without changing the action",async()=>{
  const id=await message(),reviewed=await hash(id)
  for(const expected of [null,"","0".repeat(64),reviewed.toUpperCase(),reviewed.slice(1)])expect((await claim(id,expected)).data?.denied).toMatch(/review_changed|actor_not_authorized/)
  expect((await db.from("pending_actions").update({payload:{to_phone:"+15555550123",body:"Fictional edited text",category:"marketing"}}).eq("id",id)).error).toBeNull()
  expect((await claim(id,reviewed)).data).toEqual({denied:"review_changed"})
  const fresh=await hash(id);expect(fresh).not.toBe(reviewed)
  expect((await db.from("pending_actions").update({status:"edit_requested"}).eq("id",id)).error).toBeNull()
  expect((await claim(id,fresh)).data).toEqual({denied:"review_changed"})
  expect((await status(id))?.status).toBe("edit_requested");expect(await decisions(id)).toEqual([])
  // The owner path is unchanged and still decides an action that is being edited.
  expect((await owner.rpc("claim_control_action",{p_shop:shop.shopId,p_action:id,p_actor:shop.ownerId,p_context:"hitl"})).data.id).toBe(id)
 })
 // create_quote is absent from this schema's action enum, so it cannot be queued here at all.
 it.each(["create_lead","add_note","book_appointment","reschedule_appointment","cancel_appointment","update_customer","resolve_customer","record_interaction"])("keeps %s owner-only, with the refusal audited",async type=>{
  const id=await stagePending(db,shop.shopId,shop.ownerId,type,{content:"Fictional owner-only action"})
  expect((await claim(id,"a".repeat(64))).data).toEqual({denied:"owner_approval_required"})
  expect((await status(id))?.status).toBe("pending")
  expect(await decisions(id)).toEqual([{actor_id:other.ownerId,actor_role:"manager",allowed:false,reason:"owner_approval_required",mode:"approval",context:"hitl"}])
 })
 it("never authorizes a manager through the owner entry point or a service caller",async()=>{
  const id=await message(),reviewed=await hash(id)
  expect((await manager.rpc("claim_control_action",{p_shop:shop.shopId,p_action:id,p_actor:other.ownerId,p_context:"hitl"})).data).toEqual({denied:"actor_not_authorized"})
  expect((await manager.rpc("claim_control_action",{p_shop:shop.shopId,p_action:id,p_actor:shop.ownerId,p_context:"hitl"})).data).toEqual({denied:"actor_not_authorized"})
  for(const context of ["hitl","automatic"])expect((await db.rpc("claim_control_action",{p_shop:shop.shopId,p_action:id,p_actor:other.ownerId,p_context:context})).data).toEqual({denied:"actor_not_authorized"})
  for(const client of [db,anonClient()])expect((await claim(id,reviewed,client)).error).not.toBeNull()
  for(const client of [manager,owner,db])expect((await client.rpc("control_claim",{p_shop:shop.shopId,p_action:id,p_actor:other.ownerId,p_context:"hitl",p_expected:reviewed})).error).not.toBeNull()
  expect((await status(id))?.status).toBe("pending");expect(await decisions(id)).toEqual([])
 })
 it("requires both grants, the manager role and live membership at each claim",async()=>{
  const id=await message(),reviewed=await hash(id)
  for(const capabilities of [[],["crm.read"],["crm.read","delivery.reconcile","assignments.manage","notes.write","jobs.progress"]]){
   expect((await grant(capabilities)).error).toBeNull()
   expect((await claim(id,reviewed)).data).toEqual({denied:"actor_not_authorized"})
   expect((await manager.rpc("list_delegated_message_approvals",{p_shop:shop.shopId,p_offset:0})).error?.code).toBe("42501")
  }
  expect((await grant(["approvals.messages"])).error).not.toBeNull();expect((await grant(delegated,"staff")).error).not.toBeNull()
  expect((await grant(delegated,"manager",false)).error).toBeNull();expect((await claim(id,reviewed)).data).toEqual({denied:"actor_not_authorized"})
  expect((await grant(delegated)).error).toBeNull()
  // A grant in one shop is not authority in another; the manager owns `other`.
  const foreign=await stagePending(db,other.shopId,other.ownerId,"send_sms",{to_phone:"+15555550124",body:"Fictional foreign text",category:"marketing"})
  expect((await claim(foreign,reviewed)).data).toEqual({already_decided:true})
  expect((await claim(id,reviewed,owner,other.shopId)).data).toEqual({denied:"actor_not_authorized"})
  expect((await status(foreign))?.status).toBe("pending");expect((await status(id))?.status).toBe("pending");expect(await decisions(id)).toEqual([])
 })
 it("owner and manager racing for one message produce exactly one claim",async()=>{
  const id=await message(),reviewed=await hash(id)
  const results=await Promise.all([claim(id,reviewed),owner.rpc("claim_control_action",{p_shop:shop.shopId,p_action:id,p_actor:shop.ownerId,p_context:"hitl"})])
  expect(results.filter(r=>r.data?.id===id)).toHaveLength(1);expect(results.filter(r=>r.data?.already_decided===true)).toHaveLength(1)
  expect((await decisions(id))!.filter(d=>d.allowed)).toHaveLength(1)
 })
 it("lists only unspent pending messages with presentation fields and changes nothing",async()=>{
  const customer=await db.from("customers").insert({shop_id:shop.shopId,name:"Fictional Queue Customer",phone:"+15555550177"}).select("id").single();expect(customer.error).toBeNull()
  const shown=await stagePending(db,shop.shopId,shop.ownerId,"send_email",{customer_id:customer.data!.id,to_email:"queue@example.test",subject:"Fictional subject",body:"Fictional email body",category:"marketing",reason:"Fictional follow-up",service_proof:"secret-proof",mcp_token_id:null})
  const note=await stagePending(db,shop.shopId,shop.ownerId,"add_note",{content:"Fictional note"})
  const spent=await message("Fictional spent text"),decided=await message("Fictional decided text")
  expect((await db.from("service_proof_consumptions").insert({shop_id:shop.shopId,action_id:spent,proof_id:randomUUID(),claims:{synthetic:true}})).error).toBeNull()
  expect((await db.from("pending_actions").update({status:"rejected"}).eq("id",decided)).error).toBeNull()
  const before=JSON.stringify((await db.from("pending_actions").select("*").eq("shop_id",shop.shopId).order("id")).data)
  for(const client of [owner,manager]){
   const page=await client.rpc("list_delegated_message_approvals",{p_shop:shop.shopId,p_offset:0});expect(page.error).toBeNull();expect(page.data.viewer_role).toBe(client===owner?"owner":"manager")
   const ids=page.data.items.map((x:{action_id:string})=>x.action_id);expect(ids).toContain(shown);for(const hidden of [note,spent,decided])expect(ids).not.toContain(hidden)
   const row=page.data.items.find((x:{action_id:string})=>x.action_id===shown)
   expect(row).toMatchObject({action_type:"send_email",customer_id:customer.data!.id,customer_name:"Fictional Queue Customer",destination:"queue@example.test",subject:"Fictional subject",body:"Fictional email body",purpose:"marketing",reason:"Fictional follow-up"})
   expect(Object.keys(row).sort()).toEqual(["action_id","action_type","body","created_at","customer_id","customer_name","destination","purpose","reason","review_hash","subject"])
   expect(JSON.stringify(page.data)).not.toContain("secret-proof")
  }
  expect(JSON.stringify((await db.from("pending_actions").select("*").eq("shop_id",shop.shopId).order("id")).data)).toBe(before)
  for(const client of [anonClient(),db])expect((await client.rpc("list_delegated_message_approvals",{p_shop:shop.shopId,p_offset:0})).error).not.toBeNull()
  expect((await owner.rpc("list_delegated_message_approvals",{p_shop:shop.shopId,p_offset:-1})).error?.code).toBe("22023")
  expect((await manager.from("pending_actions").select("id").eq("shop_id",shop.shopId)).data??[]).toEqual([])
 })
 it("the activated policy's manager ceiling and connector switches bind delegated approval",async()=>{
  await publish({...initialPolicyDraft(),roleCeilings:{manager:"suggest"}})
  const id=await message(),reviewed=await hash(id)
  expect((await claim(id,reviewed)).data).toEqual({denied:"execution_not_permitted"});expect((await status(id))?.status).toBe("pending")
  expect((await decisions(id))![0]).toMatchObject({actor_role:"manager",allowed:false,mode:"suggest"})
  await publish({...initialPolicyDraft(),roleCeilings:{manager:"autonomous"}})
  expect((await claim(id,reviewed)).data.id).toBe(id);expect((await decisions(id))![1]).toMatchObject({allowed:true,mode:"approval"})
  const blocked=await message("Fictional text before channel off"),blockedReview=await hash(blocked)
  await publish({...initialPolicyDraft(),connectorCeilings:{sms:"off"}})
  expect((await claim(blocked,blockedReview)).data).toEqual({denied:"execution_not_permitted"})
  await publish(initialPolicyDraft())
 })
 describe("execution after a delegated claim",()=>{
  const approve=(id:string,expectedReview:string,client=manager,executionClient=serviceClient())=>executeApproval(client,id,shop.shopId,{userId:other.ownerId},{delegated:{expectedReview,executionClient}})
  async function serviceReply(channel:"sms"|"email"){
   const destination=channel==="sms"?"+1555"+String(Math.floor(Math.random()*1e7)).padStart(7,"0"):`${randomUUID()}@example.test`
   const c=await db.from("customers").insert({shop_id:shop.shopId,name:"Fictional reply customer",do_not_contact:false,...(channel==="sms"?{phone:destination}:{email:destination})}).select("id").single();expect(c.error).toBeNull()
   const i=await db.from("interactions").insert({shop_id:shop.shopId,customer_id:c.data!.id,channel,role:"customer",content:"Fictional service question",metadata:{direction:"inbound",...(channel==="sms"?{from_phone:destination}:{from_email:destination,aurinko_message_id:"test-"+c.data!.id})}}).select("id").single();expect(i.error).toBeNull()
   if(channel==="email")expect((await db.from("email_reply_evidence").insert({shop_id:shop.shopId,interaction_id:i.data!.id,account_id:987654,message_id:"test-"+c.data!.id})).error).toBeNull()
   const action=randomUUID()
   expect((await owner.rpc("whisper_command",{p_shop:shop.shopId,p_customer:c.data!.id,p_channel:channel,p_command:action,p_latest:i.data!.id,p_revision:0,p_operation:"reply",p_payload:{destination,body:"Fictional answer to your question",subject:channel==="email"?"Service answer":""}})).error).toBeNull()
   return {action,customer:c.data!.id,destination}
  }
  for(const channel of ["sms","email"] as const){
   const transport=channel==="sms"?sendOutboundSms:sendEmailMessage
   it(`${channel}: an owner-reviewed service reply is sent once on manager approval`,async()=>{
    const f=await serviceReply(channel);expect(await reviewCommunicationPurpose(f.action,"reply")).toMatchObject({ok:true})
    const reviewed=await hash(f.action)
    const results=await Promise.all([approve(f.action,reviewed),approve(f.action,reviewed)])
    expect(results.filter(r=>r.ok&&r.status==="executed"),JSON.stringify(results)).toHaveLength(1);expect(results.filter(r=>r.ok&&r.status==="already_decided")).toHaveLength(1)
    expect(transport).toHaveBeenCalledTimes(1)
    const row=await status(f.action);expect(row).toMatchObject({status:"approved",decided_by_user:other.ownerId});expect(row!.result_id).not.toBeNull()
    expect((await decisions(f.action))!.filter(d=>d.allowed&&d.actor_role==="manager")).toHaveLength(1)
    expect((await db.from("service_proof_consumptions").select("completed_at").eq("action_id",f.action).single()).data!.completed_at).not.toBeNull()
    expect((await db.from("customer_channel_permissions").select("id").eq("shop_id",shop.shopId).eq("customer_id",f.customer)).data).toEqual([])
   })
   it(`${channel}: without consent or owner purpose review nothing is sent and the action returns to the queue`,async()=>{
    const f=await serviceReply(channel),reviewed=await hash(f.action)
    const result=await approve(f.action,reviewed);expect(result.ok).toBe(false);expect(transport).not.toHaveBeenCalled()
    expect(await status(f.action)).toEqual({status:"pending",decided_by_user:null,result_id:null})
    expect((await db.from("service_proof_consumptions").select("proof_id").eq("action_id",f.action)).data).toEqual([])
   })
  }
  it("STOP and do-not-contact still block a delegated approval",async()=>{
   for(const patch of [{do_not_contact:true},{sms_opted_out_at:new Date().toISOString()}]){
    const f=await serviceReply("sms");expect(await reviewCommunicationPurpose(f.action,"reply")).toMatchObject({ok:true})
    expect((await db.from("customers").update(patch).eq("id",f.customer)).error).toBeNull()
    const result=await approve(f.action,await hash(f.action));expect(result.ok).toBe(false)
    expect((await status(f.action))?.status).toBe("pending")
   }
   expect(sendOutboundSms).not.toHaveBeenCalled()
  })
  it("a denied claim never reaches the execution client or a provider",async()=>{
   const id=await message(),reviewed=await hash(id)
   const execution=new Proxy({},{get(){throw new Error("execution client used without a claim")}}) as SupabaseClient
   expect((await grant(["crm.read"])).error).toBeNull()
   expect(await approve(id,reviewed,manager,execution)).toEqual({ok:false,error:"Only the current shop owner can approve this action."})
   expect((await grant(delegated)).error).toBeNull()
   expect(await approve(id,"0".repeat(64),manager,execution)).toMatchObject({ok:false,error:expect.stringContaining("Refresh and review")})
   const note=await stagePending(db,shop.shopId,shop.ownerId,"add_note",{content:"Fictional note"})
   expect(await approve(note,"a".repeat(64),manager,execution)).toEqual({ok:false,error:"Only the shop owner can approve this kind of action."})
   expect((await approve(id,reviewed,anonClient(),execution)).ok).toBe(false)
   expect((await status(id))?.status).toBe("pending");expect((await status(note))?.status).toBe("pending");expect(sendOutboundSms).not.toHaveBeenCalled()
  })
 })
 describe("delegated rejection",()=>{
  const reject=(id:string,expected:string|null,client=manager,shopId=shop.shopId)=>client.rpc("reject_delegated_message",{p_shop:shopId,p_action:id,p_expected:expected})
  it("rejects exactly the reviewed message, attributed and audited, and sends nothing",async()=>{
   expect((await grant(delegated)).error).toBeNull();const id=await message(),reviewed=await hash(id)
   expect((await reject(id,reviewed)).data).toEqual({id,shop_id:shop.shopId,action_type:"send_sms"})
   expect(await status(id)).toEqual({status:"rejected",decided_by_user:other.ownerId,result_id:null})
   expect(await decisions(id)).toEqual([{actor_id:other.ownerId,actor_role:"manager",allowed:false,reason:"rejected_by_reviewer",mode:"approval",context:"hitl"}])
   expect((await reject(id,reviewed)).data).toEqual({already_decided:true});expect((await claim(id,reviewed)).data).toEqual({already_decided:true})
   expect(await decisions(id)).toHaveLength(1)
   expect((await db.from("service_proof_consumptions").select("proof_id").eq("action_id",id)).data).toEqual([])
   expect(sendOutboundSms).not.toHaveBeenCalled();expect(sendEmailMessage).not.toHaveBeenCalled()
  })
  it("the owner can restore a manager rejection, after which a fresh review can approve it",async()=>{
   const id=await message(),reviewed=await hash(id);expect((await reject(id,reviewed)).data.id).toBe(id)
   expect((await owner.from("pending_actions").update({status:"pending",decided_at:null,decided_by_user:null,resolution:null}).eq("id",id).eq("shop_id",shop.shopId).eq("status","rejected")).error).toBeNull()
   expect((await status(id))?.status).toBe("pending");expect((await claim(id,await hash(id))).data.id).toBe(id)
  })
  it("refuses stale, malformed and mid-edit reviews, other action types and already claimed sends",async()=>{
   const id=await message(),reviewed=await hash(id)
   for(const expected of [null,"","0".repeat(64),reviewed.toUpperCase()])expect((await reject(id,expected)).data?.denied).toMatch(/review_changed|actor_not_authorized/)
   expect((await db.from("pending_actions").update({status:"edit_requested"}).eq("id",id)).error).toBeNull()
   expect((await reject(id,reviewed)).data).toEqual({denied:"review_changed"});expect((await status(id))?.status).toBe("edit_requested")
   const note=await stagePending(db,shop.shopId,shop.ownerId,"add_note",{content:"Fictional note"})
   expect((await reject(note,"a".repeat(64))).data).toEqual({denied:"owner_approval_required"});expect((await status(note))?.status).toBe("pending")
   const spent=await message("Fictional claimed text")
   const spentReview=await hash(spent)
   expect((await db.from("service_proof_consumptions").insert({shop_id:shop.shopId,action_id:spent,proof_id:randomUUID(),claims:{synthetic:true}})).error).toBeNull()
   expect((await reject(spent,spentReview)).data).toEqual({denied:"delivery_review_required"});expect((await status(spent))?.status).toBe("pending")
   for(const action of [id,note,spent])expect(await decisions(action)).toEqual([])
  })
  it("requires the same grant, role, live membership and shop as approval",async()=>{
   const id=await message(),reviewed=await hash(id)
   for(const capabilities of [[],["crm.read"],["crm.read","delivery.reconcile"]]){expect((await grant(capabilities)).error).toBeNull();expect((await reject(id,reviewed)).data).toEqual({denied:"actor_not_authorized"})}
   expect((await grant(delegated,"manager",false)).error).toBeNull();expect((await reject(id,reviewed)).data).toEqual({denied:"actor_not_authorized"})
   expect((await grant(delegated)).error).toBeNull()
   for(const client of [db,anonClient()])expect((await reject(id,reviewed,client)).error).not.toBeNull()
   expect((await reject(id,reviewed,owner,other.shopId)).data).toEqual({denied:"actor_not_authorized"})
   const foreign=await stagePending(db,other.shopId,other.ownerId,"send_sms",{to_phone:"+15555550125",body:"Fictional foreign text",category:"marketing"})
   expect((await reject(foreign,reviewed)).data).toEqual({already_decided:true});expect((await status(foreign))?.status).toBe("pending")
   expect((await status(id))?.status).toBe("pending");expect(await decisions(id)).toEqual([])
  })
  it("approve and reject racing for one message have exactly one outcome and at most one send",async()=>{
   const id=await message(),f={id,reviewed:await hash(id)}
   const [approved,rejected]=await Promise.all([executeApproval(manager,f.id,shop.shopId,{userId:other.ownerId},{delegated:{expectedReview:f.reviewed,executionClient:serviceClient()}}),reject(f.id,f.reviewed)])
   const final=(await status(f.id))?.status
   if(rejected.data?.id===f.id){expect(final).toBe("rejected");expect(approved).toEqual({ok:true,status:"already_decided"});expect(sendOutboundSms).not.toHaveBeenCalled()}
   else{expect(rejected.data).toEqual({already_decided:true});expect(final).not.toBe("rejected")}
   expect((await decisions(f.id))!.length).toBe(1)
  })
 })
})
