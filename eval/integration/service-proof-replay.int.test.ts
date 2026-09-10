import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest"
import {randomUUID} from "node:crypto"
import type {SupabaseClient} from "@supabase/supabase-js"
import {executeApproval} from "@/lib/approvals"
import {issueServiceProof,claimServiceExecution} from "@/lib/service-purpose"
import {sendOutboundSms} from "@/lib/twilio"
import {sendEmailMessage,getAccessTokenForShop} from "@/lib/aurinko"
import {INTEGRATION_WITH_SESSION,serviceClient,ownerSessionClient,seedShop,stagePending,cleanup,type Seeded} from "./_db"
vi.mock("@/lib/telephony-provider",async original=>({...await original<typeof import("@/lib/telephony-provider")>(),smsGateForShop:()=>({allowed:true})}))
vi.mock("@/lib/twilio",async original=>({...await original<typeof import("@/lib/twilio")>(),sendOutboundSms:vi.fn(async()=>({messageSid:"synthetic-message",status:"queued"}))}))
vi.mock("@/lib/aurinko",async original=>({...await original<typeof import("@/lib/aurinko")>(),getAccessTokenForShop:vi.fn(async()=>"synthetic-token"),sendEmailMessage:vi.fn(async()=>({id:"synthetic-email"}))}))
vi.mock("@/lib/memory",async original=>({...await original<typeof import("@/lib/memory")>(),recordInteraction:vi.fn(async()=>({ok:true as const,id:randomUUID(),embedded:false}))}))
vi.mock("@/lib/credits",()=>({recordUsage:vi.fn()}))
vi.mock("@/lib/pricing",async original=>({...await original<typeof import("@/lib/pricing")>(),getPricing:vi.fn(),priceUsage:()=>({credits:0,wholesale_cost:0,retail_cost:0})}))
describe.skipIf(!INTEGRATION_WITH_SESSION)("durable service proof execution",()=>{
 let db:SupabaseClient,owner:SupabaseClient,shop:Seeded,customer:string,appointment:string
 beforeAll(async()=>{
  db=serviceClient();const password=randomUUID();shop=await seedShop(db,{password});owner=await ownerSessionClient(shop.email,password)
  expect((await db.from("shops").update({quiet_hours_start:0,quiet_hours_end:0,twilio_phone_number:"+15550001111"}).eq("id",shop.shopId)).error).toBeNull()
  const c=await db.from("customers").insert({shop_id:shop.shopId,name:"Synthetic replay",phone:"+15551112222",email:"replay@example.test",do_not_contact:false}).select("id").single();expect(c.error).toBeNull();customer=c.data!.id
  const a=await db.from("appointments").insert({shop_id:shop.shopId,customer_id:customer,scheduled_at:"2032-01-01T12:00:00Z"}).select("id").single();expect(a.error).toBeNull();appointment=a.data!.id
 })
 afterEach(()=>vi.clearAllMocks())
 afterAll(async()=>{if(shop)await cleanup(db,shop)})
 async function fixture(channel:"sms"|"email") {
  const message={shopId:shop.shopId,customerId:customer,channel,destination:channel==="sms"?"+15551112222":"replay@example.test",body:"Your appointment is confirmed",...(channel==="email"?{subject:"Confirmation"}:{})}
  const proof=await issueServiceProof(db,message,{kind:"appointment",id:appointment});expect(proof).toBeTruthy()
  const payload={customer_id:customer,category:"transactional",service_proof:proof,body:message.body,...(channel==="sms"?{to_phone:message.destination}:{to_email:message.destination,subject:message.subject})}
  const stage=()=>stagePending(db,shop.shopId,shop.ownerId,channel==="sms"?"send_sms":"send_email",payload)
  return {proof:proof!,message,stage}
 }
 const execute=(id:string,client=db)=>executeApproval(client,id,shop.shopId,{userId:shop.ownerId})
 async function events(proof:string) {
  const nonce=JSON.parse(Buffer.from(proof,"base64url").toString()).nonce
  const r=await owner.from("service_proof_audit").select("event").eq("shop_id",shop.shopId).eq("proof_id",nonce);expect(r.error).toBeNull();return r.data!.map(x=>x.event)
 }
 it("SQL claim accepts verified canonical metadata exactly once",async()=>{
  const f=await fixture("sms"),id=await f.stage()
  expect((await db.from("pending_actions").update({status:"approved"}).eq("id",id)).error).toBeNull()
  const claims=JSON.parse(Buffer.from(f.proof,"base64url").toString());delete claims.signature
  const result=await db.rpc("claim_service_execution",{p_shop:shop.shopId,p_action:id,p_pending:true,p_claims:claims})
  expect(result.error).toBeNull();expect(result.data).toBe("claimed")
 })
 for(const channel of ["sms","email"] as const) {
  const transport=channel==="sms"?sendOutboundSms:sendEmailMessage
  it(`${channel}: sequential cross-action replay and completed same-action retry send once`,async()=>{
   const f=await fixture(channel),first=await f.stage(),second=await f.stage()
   expect(await execute(first,owner)).toMatchObject({ok:true,status:"executed"})
   expect(await execute(second)).toMatchObject({ok:false,error:expect.stringContaining("already used")})
   expect(await execute(first)).toEqual({ok:true,status:"already_decided"})
   expect(transport).toHaveBeenCalledTimes(1)
   if(channel==="email")expect(getAccessTokenForShop).toHaveBeenCalledTimes(1)
   expect(await events(f.proof)).toEqual(expect.arrayContaining(["execution_claimed","execution_completed","cross_action_replay_denied","same_action_retry"]))
  })
  it(`${channel}: competing database connections have exactly one winner and provider call`,async()=>{
   const f=await fixture(channel),ids=await Promise.all(Array.from({length:6},()=>f.stage()))
   const results=await Promise.all(ids.map(id=>execute(id,serviceClient())))
   expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok)).toHaveLength(5)
   expect(transport).toHaveBeenCalledTimes(1)
   const audit=await events(f.proof);expect(audit.filter(x=>x==="execution_claimed")).toHaveLength(1);expect(audit.filter(x=>x==="cross_action_replay_denied")).toHaveLength(5)
  })
  it(`${channel}: reloaded execution module and new connection cannot reuse serialized authority`,async()=>{
   const f=await fixture(channel);expect(await execute(await f.stage())).toMatchObject({ok:true})
   vi.resetModules()
   const {executeApproval:reloaded}=await import("@/lib/approvals")
   expect(await reloaded(serviceClient(),await f.stage(),shop.shopId,{userId:shop.ownerId})).toMatchObject({ok:false,error:expect.stringContaining("already used")})
   expect(transport).toHaveBeenCalledTimes(1)
  })
  it(`${channel}: database claim error has zero provider or token refresh effects`,async()=>{
   const f=await fixture(channel),id=await f.stage()
   const failed=new Proxy(db,{get(target,key){if(key==="rpc")return ()=>Promise.resolve({data:null,error:{message:"Injected claim failure"}});const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value}})
   expect(await execute(id,failed)).toMatchObject({ok:false,error:expect.stringContaining("could not be claimed")})
   expect(transport).not.toHaveBeenCalled();expect(getAccessTokenForShop).not.toHaveBeenCalled()
   expect(await events(f.proof)).toEqual([])
  })
 }
 it("a missing pending action cannot consume a valid proof",async()=>{
  const f=await fixture("sms")
  expect(await claimServiceExecution(db,{...f.message,actionId:randomUUID()},f.proof)).toMatchObject({ok:false})
  expect(await events(f.proof)).toEqual([]);expect(sendOutboundSms).not.toHaveBeenCalled()
 })
 it("an ambiguous provider failure keeps its proof consumed across retry",async()=>{
  const f=await fixture("sms"),id=await f.stage()
  vi.mocked(sendOutboundSms).mockRejectedValueOnce(new Error("Synthetic uncertain delivery"))
  expect(await execute(id)).toMatchObject({ok:false,error:expect.stringContaining("Synthetic uncertain delivery")})
  expect(await execute(id,serviceClient())).toMatchObject({ok:false,error:expect.stringContaining("already used")})
  expect(sendOutboundSms).toHaveBeenCalledTimes(1)
  expect(await events(f.proof)).toEqual(expect.arrayContaining(["execution_claimed","same_action_retry"]))
  expect(await events(f.proof)).not.toContain("execution_completed")
 })
 it("a proof bound at issue time refuses a different action before claiming",async()=>{
  const f=await fixture("sms"),first=await f.stage()
  const proof=await issueServiceProof(db,{...f.message,actionId:first},{kind:"appointment",id:appointment})
  expect(await claimServiceExecution(db,{...f.message,actionId:await f.stage()},proof)).toMatchObject({ok:false,reason:expect.stringContaining("context_mismatch")})
  expect(await events(proof!)).toEqual([])
 })
 it("invalid, expired and changed-context denials retain distinct audit reasons for both channels",async()=>{
  for(const channel of ["sms","email"] as const)for(const kind of ["invalid_proof","expired_proof","context_mismatch"] as const){
   const f=await fixture(channel),id=await f.stage()
   const row=await db.from("pending_actions").select("payload").eq("id",id).single();expect(row.error).toBeNull()
   const payload={...row.data!.payload}
   if(kind==="invalid_proof")payload.service_proof="forged"
   if(kind==="context_mismatch")payload.body+=" edited"
   if(kind==="expired_proof"){
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()-25*60*60*1000)
    try {payload.service_proof=await issueServiceProof(db,f.message,{kind:"appointment",id:appointment})}finally{clock.mockRestore()}
   }
   expect((await db.from("pending_actions").update({payload}).eq("id",id)).error).toBeNull()
   expect(await execute(id)).toMatchObject({ok:false})
   const audit=await owner.from("service_proof_audit").select("event").eq("shop_id",shop.shopId).eq("action_id",id)
   expect(audit.error).toBeNull();expect(audit.data).toEqual([{event:kind}])
  }
  expect(sendOutboundSms).not.toHaveBeenCalled();expect(sendEmailMessage).not.toHaveBeenCalled();expect(getAccessTokenForShop).not.toHaveBeenCalled()
 })
 it("owners cannot edit or delete durable consumption and audit records",async()=>{
  const f=await fixture("sms");expect(await execute(await f.stage())).toMatchObject({ok:true})
  for(const table of ["service_proof_consumptions","service_proof_audit"])expect((await owner.from(table).delete().eq("shop_id",shop.shopId)).error).not.toBeNull()
 })
})
