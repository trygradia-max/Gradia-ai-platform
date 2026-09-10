import { issueServiceProof } from "@/lib/service-purpose"
import { beforeAll, afterAll, describe, it, expect } from "vitest"
import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { INTEGRATION_WITH_SESSION, serviceClient, seedShop, cleanup, ownerSessionClient, type Seeded } from "./_db"
import { evaluateCustomerSendPolicy } from "@/lib/send-policy"

describe.skipIf(!INTEGRATION_WITH_SESSION)("tenant relationships under actual Postgres", () => {
  let db: SupabaseClient, owner: SupabaseClient, a: Seeded, b: Seeded
  let ca: string, cb: string, va: string, vb: string, la: string, lb: string, qa: string, qb: string, appt: string
  async function insert(table:string, values:Record<string,unknown>) {
    const {data,error} = await db.from(table).insert(values).select("id").single()
    expect(error).toBeNull();return data!.id as string
  }
  beforeAll(async () => {
    db=serviceClient();const password=randomUUID();a=await seedShop(db,{password});b=await seedShop(db)
    owner=await ownerSessionClient(a.email,password)
    ca=await insert("customers",{shop_id:a.shopId,name:"Synthetic A",phone:"+15550001111",email:"a@example.test"})
    cb=await insert("customers",{shop_id:b.shopId,name:"Synthetic B",phone:"+15550002222",email:"b@example.test"})
    va=await insert("vehicles",{shop_id:a.shopId,customer_id:ca,make:"Ford"});vb=await insert("vehicles",{shop_id:b.shopId,customer_id:cb,make:"Ford"})
    la=await insert("leads",{shop_id:a.shopId,customer_id:ca,customer_name:"A",phone:"+15550001111"})
    lb=await insert("leads",{shop_id:b.shopId,customer_id:cb,customer_name:"B",phone:"+15550002222"})
    qa=await insert("quotes",{shop_id:a.shopId,customer_id:ca,vehicle_id:va,lead_id:la})
    qb=await insert("quotes",{shop_id:b.shopId,customer_id:cb,vehicle_id:vb,lead_id:lb})
    appt=await insert("appointments",{shop_id:a.shopId,scheduled_at:"2032-01-01T12:00:00Z",customer_id:ca,vehicle_id:va,lead_id:la,quote_id:qa})
  })
  afterAll(async()=> { if(a)await cleanup(db,a);if(b)await cleanup(db,b) })
  for (const actor of ["service","owner"] as const) {
    it(`${actor} cannot insert any foreign quote/vehicle/interaction parent`, async()=> {
      const client=actor === "service" ? db : owner
      const cases:[string,Record<string,unknown>][]=[
        ["quotes",{shop_id:a.shopId,customer_id:cb}],
        ["quotes",{shop_id:a.shopId,customer_id:ca,vehicle_id:vb}],
        ["quotes",{shop_id:a.shopId,customer_id:ca,lead_id:lb}],
        ["vehicles",{shop_id:a.shopId,customer_id:cb,make:"Ford"}],
        ["interactions",{shop_id:a.shopId,customer_id:cb,channel:"note",role:"system",content:"denied"}],
        ["customer_channel_permissions",{shop_id:a.shopId,customer_id:cb,channel:"sms",destination:"+15550002222"}],
      ]
      for(const [table,values] of cases) expect((await client.from(table).insert(values)).error?.code).toBe("23503")
    })
    it(`${actor} cannot update appointments/leads to foreign customer, vehicle, lead or quote`,async()=> {
      const client=actor === "service" ? db : owner
      for(const patch of [{customer_id:cb},{vehicle_id:vb},{lead_id:lb},{quote_id:qb}]) expect((await client.from("appointments").update(patch).eq("id",appt)).error?.code).toBe("23503")
      for(const patch of [{customer_id:cb},{vehicle_id:vb},{quote_id:qb}]) expect((await client.from("leads").update(patch).eq("id",la)).error?.code).toBe("23503")
    })
  }
  it("database denies foreign/traversal photo paths and accepts canonical owned paths",async()=> {
    for(const path of [`${b.shopId}/${appt}/before-${randomUUID()}.jpg`,`${a.shopId}/${randomUUID()}/before-${randomUUID()}.jpg`,`${a.shopId}/${appt}/../x.jpg`]) expect((await owner.from("appointments").update({photos_before:[path]}).eq("id",appt)).error?.code).toBe("23514")
    expect((await owner.from("appointments").update({photos_before:[`${a.shopId}/${appt}/before-${randomUUID()}.jpg`]}).eq("id",appt)).error).toBeNull()
  })
  it("real recipient lookups reject cross-shop IDs and destination mismatches",async()=> {
    const serviceProof=await issueServiceProof(db,{shopId:a.shopId,customerId:ca,channel:"email",destination:"a@example.test",body:""},{kind:"quote",id:qa})
    const shop={id:a.shopId,timezone:"UTC",quiet_hours_start:0,quiet_hours_end:0}
    for(const [customerId,destination] of [[cb,"b@example.test"],[ca,"b@example.test"]]) expect((await evaluateCustomerSendPolicy(db,shop,{channel:"email",customerId,destination,category:"transactional",serviceProof})).allowed).toBe(false)
    expect((await evaluateCustomerSendPolicy(db,shop,{channel:"email",customerId:ca,destination:"A@example.test",category:"transactional",serviceProof})).allowed).toBe(true)
    expect((await evaluateCustomerSendPolicy(db,shop,{channel:"email",customerId:ca,destination:"a@example.test",category:"marketing"})).allowed).toBe(false)
    await insert("customer_channel_permissions",{shop_id:a.shopId,customer_id:ca,channel:"email",destination:"a@example.test",marketing_consent_at:new Date().toISOString(),consent_source:"synthetic test"})
    expect((await evaluateCustomerSendPolicy(db,shop,{channel:"email",customerId:ca,destination:"a@example.test",category:"marketing"})).allowed).toBe(true)
    expect((await db.from("customer_channel_permissions").update({suppressed_at:new Date().toISOString()}).eq("customer_id",ca)).error).toBeNull()
    expect((await evaluateCustomerSendPolicy(db,shop,{channel:"email",customerId:ca,destination:"a@example.test",category:"transactional",serviceProof})).allowed).toBe(false)
  })
  it("preserves nullable references and SET NULL without clearing shop_id",async()=> {
    const lead=await insert("leads",{shop_id:a.shopId,customer_name:"Nullable",phone:"+15550003333"})
    const appointment=await insert("appointments",{shop_id:a.shopId,scheduled_at:"2032-02-01T12:00:00Z",lead_id:lead})
    expect((await db.from("leads").delete().eq("id",lead)).error).toBeNull()
    const {data,error}=await db.from("appointments").select("shop_id,lead_id,customer_id,vehicle_id,quote_id").eq("id",appointment).single()
    expect(error).toBeNull();expect(data).toEqual({shop_id:a.shopId,lead_id:null,customer_id:null,vehicle_id:null,quote_id:null})
  })
  it("preserves customer cascade and nullable appointment references",async()=> {
    const c=await insert("customers",{shop_id:a.shopId,name:"Delete synthetic"})
    const v=await insert("vehicles",{shop_id:a.shopId,customer_id:c,make:"Ford"})
    const q=await insert("quotes",{shop_id:a.shopId,customer_id:c,vehicle_id:v})
    const j=await insert("appointments",{shop_id:a.shopId,scheduled_at:"2032-03-01T12:00:00Z",customer_id:c,vehicle_id:v,quote_id:q})
    expect((await db.from("customers").delete().eq("id",c)).error).toBeNull()
    expect((await db.from("vehicles").select("id").eq("id",v)).data).toHaveLength(0)
    expect((await db.from("quotes").select("id").eq("id",q)).data).toHaveLength(0)
    expect((await db.from("appointments").select("shop_id,customer_id,vehicle_id,quote_id").eq("id",j).single()).data).toEqual({shop_id:a.shopId,customer_id:null,vehicle_id:null,quote_id:null})
  })
})
