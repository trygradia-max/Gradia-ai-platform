import {beforeAll,afterAll,describe,it,expect} from "vitest"
import type {SupabaseClient} from "@supabase/supabase-js"
import {INTEGRATION_WITH_SESSION,serviceClient,seedShop,cleanup,ownerSessionClient,type Seeded} from "./_db"
import {randomUUID} from "node:crypto"
describe.skipIf(!INTEGRATION_WITH_SESSION)("atomic consent-preserving customer merge",()=>{
 let db:SupabaseClient,owner:SupabaseClient,shop:Seeded
 beforeAll(async()=>{db=serviceClient();const password=randomUUID();shop=await seedShop(db,{password});owner=await ownerSessionClient(shop.email,password)})
 afterAll(async()=>{if(shop)await cleanup(db,shop)})
 async function insert(table:string,values:Record<string,unknown>) {const {data,error}=await db.from(table).insert({shop_id:shop.shopId,...values}).select("*").single();expect(error).toBeNull();return data!}
 async function customer(extra:Record<string,unknown>={}) {return insert("customers",{name:"Synthetic",...extra})}
 async function permission(customer_id:string,extra:Record<string,unknown>={}) {return insert("customer_channel_permissions",{customer_id,channel:"email",destination:"same@example.test",marketing_consent_at:"2026-01-01T00:00:00Z",consent_source:"synthetic",...extra})}
 async function otherChildren(customer_id:string) {
  const lead=await insert("leads",{customer_id,customer_name:"Synthetic",phone:"+15553334444"})
  const appt=await insert("appointments",{customer_id,scheduled_at:"2032-01-01T12:00:00Z"})
  const payment=await insert("payments",{customer_id,amount_cents:100,stripe_invoice_id:randomUUID()})
  const call=await insert("call_records",{customer_id,vapi_call_id:randomUUID()})
  const automation=await insert("automations",{catalog_key:randomUUID()})
  const run=await insert("automation_runs",{customer_id,automation_id:automation.id})
  return [["leads",lead.id],["appointments",appt.id],["payments",payment.id],["call_records",call.id],["automation_runs",run.id]]
 }
 async function merge(w:string,l:string){return owner.rpc("merge_customers_atomic",{p_shop:shop.shopId,p_winner:w,p_loser:l})}
 for(const reverse of [false,true]) {
  it(`preserves DNC, STOP and channel suppression in direction ${reverse}`,async()=>{
   const safe=await customer(),blocked=await customer({do_not_contact:true,sms_opted_out_at:"2026-01-02T00:00:00Z"})
   await permission(blocked.id,{suppressed_at:"2026-01-03T00:00:00Z",suppression_source:"operator"});await permission(safe.id)
   const w=reverse?blocked:safe,l=reverse?safe:blocked
   expect((await merge(w.id,l.id)).error).toBeNull()
   const result=await db.from("customers").select("*").eq("id",w.id).single()
   expect(result.data).toMatchObject({do_not_contact:true});expect(result.data!.sms_opted_out_at).not.toBeNull()
   const permissions=await db.from("customer_channel_permissions").select("*").eq("customer_id",w.id)
   expect(permissions.data).toHaveLength(1);expect(permissions.data![0].suppressed_at).not.toBeNull()
   const history=await owner.from("customer_merge_history").select("evidence").eq("loser_id",l.id).single()
   expect(history.data!.evidence.permissions).toHaveLength(2)
  })
 }
 it("retains multiple channel destinations and never substitutes the winner destination",async()=>{
  const w=await customer({email:"winner@example.test"}),l=await customer({email:"loser@example.test"})
  await permission(w.id,{destination:"winner@example.test",marketing_consent_at:null})
  await permission(l.id,{destination:"loser@example.test",suppressed_at:"2026-01-01T00:00:00Z"})
  await permission(l.id,{destination:"historical@example.test"})
  expect((await merge(w.id,l.id)).error).toBeNull()
  const {data}=await db.from("customer_channel_permissions").select("*").eq("customer_id",w.id)
  expect(data).toHaveLength(3)
  expect(data!.find(p=>p.destination==="winner@example.test").marketing_consent_at).toBeNull()
  expect(data!.find(p=>p.destination==="loser@example.test").suppressed_at).not.toBeNull()
 })
 it("matching destination with unknown versus affirmative permission remains unknown",async()=>{
  const w=await customer(),l=await customer();await permission(w.id);await permission(l.id,{marketing_consent_at:null})
  expect((await merge(w.id,l.id)).error).toBeNull()
  expect((await db.from("customer_channel_permissions").select("marketing_consent_at").eq("customer_id",w.id).single()).data!.marketing_consent_at).toBeNull()
 })
 it("moves child relationships and nested pending/interaction customer references atomically",async()=>{
  const w=await customer(),l=await customer()
  const others=await otherChildren(l.id)
  const v=await insert("vehicles",{customer_id:l.id,make:"Ford"})
  const q=await insert("quotes",{customer_id:l.id,vehicle_id:v.id})
  const i=await insert("interactions",{customer_id:l.id,channel:"note",role:"system",content:"synthetic",metadata:{customer_id:l.id}})
  const p=await insert("pending_actions",{action_type:"send_sms",payload:{customer_id:l.id,nested:{customer_id:l.id},to_phone:"+15550001111"},requested_by:shop.ownerId})
  expect((await merge(w.id,l.id)).error).toBeNull()
  for(const [table,id] of [...others,["vehicles",v.id],["quotes",q.id],["interactions",i.id]]) expect((await db.from(table).select("customer_id").eq("id",id).single()).data!.customer_id).toBe(w.id)
  const {data}=await db.from("pending_actions").select("payload").eq("id",p.id).single();expect(data!.payload).toMatchObject({customer_id:w.id,nested:{customer_id:w.id},to_phone:"+15550001111"})
 })
 it("refuses foreign customers with no merge history",async()=>{
  const w=await customer();const result=await merge(w.id,randomUUID());expect(result.error?.message).toContain("Both customers")
  expect((await db.from("customer_merge_history").select("id").eq("winner_id",w.id)).data).toHaveLength(0)
 })
 it("injected mid-merge failure rolls back every relationship, permission, identifier and audit row",async()=>{
  const w=await customer({name:"P0_INJECT_MERGE_FAILURE"}),l=await customer({email:"rollback@example.test"})
  const others=await otherChildren(l.id)
  const v=await insert("vehicles",{customer_id:l.id,make:"Ford"})
  const q=await insert("quotes",{customer_id:l.id,vehicle_id:v.id})
  const permissionRow=await permission(l.id,{suppressed_at:"2026-01-01T00:00:00Z"})
  const p=await insert("pending_actions",{action_type:"send_sms",payload:{customer_id:l.id},requested_by:shop.ownerId})
  const result=await merge(w.id,l.id);expect(result.error?.message).toContain("Injected mid-merge failure")
  for(const [table,id] of [...others,["vehicles",v.id],["quotes",q.id],["customer_channel_permissions",permissionRow.id]]) expect((await db.from(table).select("customer_id").eq("id",id).single()).data!.customer_id).toBe(l.id)
  expect((await db.from("customers").select("email").eq("id",l.id).single()).data!.email).toBe("rollback@example.test")
  expect((await db.from("pending_actions").select("payload").eq("id",p.id).single()).data!.payload.customer_id).toBe(l.id)
  expect((await db.from("customer_merge_history").select("id").eq("winner_id",w.id)).data).toHaveLength(0)
 })

})
