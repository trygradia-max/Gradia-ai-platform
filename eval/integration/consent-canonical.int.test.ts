import {beforeAll,afterAll,describe,it,expect} from "vitest"
import type {SupabaseClient} from "@supabase/supabase-js"
import {INTEGRATION,serviceClient,seedShop,cleanup,type Seeded} from "./_db"
import {isOwnedJobPhotoPath} from "@/lib/job-photo-paths"
import {normalizeDestination} from "@/lib/contact-destination"
describe.skipIf(!INTEGRATION)("canonical consent and SMS lifecycle",()=>{
 let db:SupabaseClient,shop:Seeded,c:string
 beforeAll(async()=>{db=serviceClient();shop=await seedShop(db);const r=await db.from("customers").insert({shop_id:shop.shopId,name:"Synthetic",email:"UPPER@example.test",phone:"+1 (555) 222-3333"}).select("id").single();expect(r.error).toBeNull();c=r.data!.id})
 afterAll(async()=>{if(shop)await cleanup(db,shop)})
 it("SQL and application canonicalization agree without guessing identities",async()=>{
  for(const channel of ["sms","email"] as const) for(const value of [" A@EXAMPLE.TEST ","+1 (555) 222-3333","5552223333","+0123456789","säm@example.test","\tA@example.test\n","+1555/2223333",""]) {
   const r=await db.rpc("canonical_contact_destination",{channel,value});expect(r.error).toBeNull();expect(r.data).toBe(normalizeDestination(channel,value))
  }
 })
 it("canonical customer collisions and noncanonical permissions are refused without repairing existing records",async()=>{
  for(const patch of [{email:" upper@EXAMPLE.test "},{phone:"+15552223333"}]) expect((await db.from("customers").insert({shop_id:shop.shopId,name:"Collision",...patch})).error?.code).toBe("23505")
  for(const destination of ["UPPER@example.test"," upper@example.test "]) expect((await db.from("customer_channel_permissions").insert({shop_id:shop.shopId,customer_id:c,channel:"email",destination,suppressed_at:new Date().toISOString()})).error?.code).toBe("23514")
  expect((await db.from("customers").select("email,phone").eq("id",c).single()).data).toEqual({email:"upper@example.test",phone:"+15552223333"})
 })
 it("duplicate destination permission conflicts require explicit reconciliation",async()=>{
  const row={shop_id:shop.shopId,customer_id:c,channel:"email",destination:"upper@example.test",suppressed_at:new Date().toISOString()}
  expect((await db.from("customer_channel_permissions").insert(row)).error).toBeNull()
  expect((await db.from("customer_channel_permissions").insert({...row,suppressed_at:null,marketing_consent_at:new Date().toISOString(),consent_source:"synthetic"})).error?.code).toBe("23505")
  expect((await db.from("customer_channel_permissions").select("suppressed_at").eq("customer_id",c).eq("channel","email").single()).data!.suppressed_at).not.toBeNull()
 })
 it("START grants only that SMS destination and cannot clear DNC or operator suppression",async()=>{
  const args={p_shop:shop.shopId,p_customer:c,p_destination:"+15552223333",p_opted_in:false}
  expect((await db.rpc("record_sms_keyword",args)).error).toBeNull()
  expect((await db.rpc("record_sms_keyword",{...args,p_opted_in:true})).error).toBeNull()
  const sms=()=>db.from("customer_channel_permissions").select("*").eq("customer_id",c).eq("channel","sms").single()
  expect((await sms()).data).toMatchObject({destination:"+15552223333",suppressed_at:null,consent_source:"sms_keyword"})
  expect((await db.from("customers").update({do_not_contact:true}).eq("id",c)).error).toBeNull()
  expect((await db.from("customer_channel_permissions").update({suppressed_at:new Date().toISOString(),suppression_source:"operator"}).eq("customer_id",c).eq("channel","sms")).error).toBeNull()
  expect((await db.rpc("record_sms_keyword",{...args,p_opted_in:true})).error).toBeNull()
  expect((await sms()).data!.suppressed_at).not.toBeNull()
  expect((await db.from("customers").select("do_not_contact,marketing_consent_at").eq("id",c).single()).data).toEqual({do_not_contact:true,marketing_consent_at:null})
  expect((await db.rpc("record_sms_keyword",{...args,p_destination:"+15559999999"})).error?.message).toContain("does not belong")
 })
 it("a same-shop vehicle belonging to another customer cannot be used on a quote",async()=>{
  const other=await db.from("customers").insert({shop_id:shop.shopId,name:"Other synthetic"}).select("id").single();expect(other.error).toBeNull()
  const v=await db.from("vehicles").insert({shop_id:shop.shopId,customer_id:other.data!.id,make:"Ford"}).select("id").single();expect(v.error).toBeNull()
  expect((await db.from("quotes").insert({shop_id:shop.shopId,customer_id:c,vehicle_id:v.data!.id})).error?.code).toBe("23503")
 })
 it("SQL and application photo predicates agree on phase, casing and traversal",async()=>{
  const appointment="12345678-1234-4234-9234-123456789abc"
  const name="before-12345678-1234-4234-9234-123456789abc.jpg"
  for(const phase of ["before","after","BEFORE","before|after",".*","["]) for(const path of [`${shop.shopId}/${appointment}/${name}`,`${shop.shopId}/${appointment}/${name.toUpperCase()}`,`${shop.shopId}/${appointment}/../${name}`,`${shop.shopId}/${appointment}/before-12345678-1234-4234-9234-123456789abc.JPG`]) {
   const result=await db.rpc("valid_job_photo_paths",{paths:[path],shop:shop.shopId,appointment,phase})
   expect(result.error).toBeNull();expect(result.data).toBe(isOwnedJobPhotoPath(path,shop.shopId,appointment,phase as "before"))
  }
 })

})
