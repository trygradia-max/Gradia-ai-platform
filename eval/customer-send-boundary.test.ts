import { afterEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readDb, safeCustomer, safeShop } from "./_tenant-fixtures"
import { executeApproval } from "@/lib/approvals"
import { sendOperatorSms } from "@/app/actions/outbound-sms"
import { sendOutboundSms } from "@/lib/twilio"
import { getAccessTokenForShop, sendEmailMessage } from "@/lib/aurinko"
import { sendOpsAlert } from "@/lib/alerts"
import { recordInteraction } from "@/lib/memory"
import { issueServiceProof } from "@/lib/service-purpose"
vi.mock("@/lib/credits", () => ({ recordUsage: vi.fn() }))
vi.mock("@/lib/pricing", async original => ({...await original<typeof import("@/lib/pricing")>(), getPricing: vi.fn(), priceUsage: () => ({credits:0,wholesale_cost:0,retail_cost:0})}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/shop", () => ({ requireUser: async () => ({id:"owner"}), requireShop: async () => safeShop }))
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => currentDb }))
vi.mock("@/lib/telephony-provider", async original => ({...await original<typeof import("@/lib/telephony-provider")>(), smsGateForShop: () => ({allowed:true})}))
vi.mock("@/lib/twilio", async original => ({...await original<typeof import("@/lib/twilio")>(), sendOutboundSms: vi.fn()}))
vi.mock("@/lib/aurinko", async original => ({...await original<typeof import("@/lib/aurinko")>(), sendEmailMessage: vi.fn(), getAccessTokenForShop: vi.fn()}))
vi.mock("@/lib/memory", async original => ({...await original<typeof import("@/lib/memory")>(), recordInteraction: vi.fn()}))
vi.mock("@/lib/alerts", () => ({ sendOpsAlert: vi.fn() }))
let currentDb: SupabaseClient
function dbFor(action: "send_sms" | "send_email", customer = safeCustomer, failure?: string) {
  const claimed = {id:"pending",shop_id:safeShop.id,action_type:action,payload:{customer_id:"c1",to_phone:safeCustomer.phone,to_email:safeCustomer.email,body:"Hello",subject:"Service",category:"transactional"}}
  const {db} = readDb({customers:[customer],shops:[{...safeShop,twilio_phone_number:"+15550001111"}]},failure)
  const pending = {update: () => pending,eq: () => pending,in: () => pending,select: () => pending,maybeSingle: async () => ({data:claimed,error:null})}
  currentDb = {from: (table:string) => table === "pending_actions" ? pending : db.from(table)} as unknown as SupabaseClient
  return currentDb
}
afterEach(() => vi.clearAllMocks())
describe("denied sends have zero external effects", () => {
  it.each(["send_sms","send_email"] as const)("%s: mismatched destination cannot reach transport or token refresh", async action => {
    const customer = {...safeCustomer,phone:"+15559998888",email:"other@example.test"}
    const result = await executeApproval(dbFor(action,customer),"pending",safeShop.id,{userId:"owner"})
    expect(result).toMatchObject({ok:false,error:"Held for review — Destination does not belong to the referenced customer."})
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(sendEmailMessage).not.toHaveBeenCalled()
    expect(getAccessTokenForShop).not.toHaveBeenCalled()
    expect(recordInteraction).not.toHaveBeenCalled()
  })
  it.each(["customers","customer_channel_permissions"])("manual SMS fails closed on %s read failure", async table => {
    dbFor("send_sms",safeCustomer,table)
    expect((await sendOperatorSms({to_phone:safeCustomer.phone,body:"Hello"})).ok).toBe(false)
    expect(sendOutboundSms).not.toHaveBeenCalled()
    expect(recordInteraction).not.toHaveBeenCalled()
  })
  it("manual SMS cannot bypass DNC", async () => {
    dbFor("send_sms",{...safeCustomer,do_not_contact:true})
    expect((await sendOperatorSms({to_phone:safeCustomer.phone,body:"Hello"})).ok).toBe(false)
    expect(sendOutboundSms).not.toHaveBeenCalled()
  })
})

it("foreign pending-action denial logs locally without provider alerts", async () => {
  const pending = {update: () => pending, eq: () => pending, in: () => pending, select: () => pending, maybeSingle: vi.fn().mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:{id:"foreign",shop_id:"shop-2"},error:null})}
  const db = {from:()=>pending} as unknown as SupabaseClient
  expect(await executeApproval(db,"foreign","shop-1",{userId:"owner"})).toMatchObject({status:"already_decided"})
  expect(sendOpsAlert).not.toHaveBeenCalled()
})

it.each(["send_sms","send_email"] as const)("%s cannot use an unproven transactional category",async action=>{
 const result=await executeApproval(dbFor(action),"pending",safeShop.id,{userId:"owner"})
 expect(result).toMatchObject({ok:false,error:expect.stringContaining("Service purpose could not be verified")})
 expect(sendOutboundSms).not.toHaveBeenCalled();expect(sendEmailMessage).not.toHaveBeenCalled()
 expect(getAccessTokenForShop).not.toHaveBeenCalled();expect(recordInteraction).not.toHaveBeenCalled()
})
it("manual arbitrary promotion requires affirmative marketing consent",async()=>{
 dbFor("send_sms")
 expect(await sendOperatorSms({to_phone:safeCustomer.phone,body:"Buy our promotion"})).toMatchObject({ok:false,error:expect.stringContaining("No affirmative consent")})
 expect(sendOutboundSms).not.toHaveBeenCalled();expect(recordInteraction).not.toHaveBeenCalled()
})
it("a service proof cannot be replayed through a second pending action",async()=>{
 vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-unit-purpose-signing-material")
 try {
  const {db}=readDb({customers:[safeCustomer],shops:[{...safeShop,quiet_hours_start:0,quiet_hours_end:0,twilio_phone_number:"+15550001111"}],appointments:[{id:"appointment",shop_id:safeShop.id,customer_id:safeCustomer.id}]})
  const proof=await issueServiceProof(db,{shopId:safeShop.id,customerId:safeCustomer.id,channel:"sms",destination:safeCustomer.phone,body:"Appointment confirmed"},{kind:"appointment",id:"appointment"})
  expect(proof).toBeTruthy()
  const payload={customer_id:safeCustomer.id,to_phone:safeCustomer.phone,body:"Appointment confirmed",category:"transactional",service_proof:proof}
  vi.mocked(sendOutboundSms).mockResolvedValue({messageSid:"synthetic-message",status:"queued"})
  vi.mocked(recordInteraction).mockResolvedValue({ok:true,id:"synthetic-interaction",embedded:false})
  function actionDb(id:string) {
   const pending={update:()=>pending,eq:()=>pending,in:()=>pending,select:()=>pending,maybeSingle:async()=>({data:{id,shop_id:safeShop.id,action_type:"send_sms",payload},error:null})}
   return {from:(table:string)=>table==="pending_actions"?pending:db.from(table)} as unknown as SupabaseClient
  }
  expect(await executeApproval(actionDb("first-action"),"first-action",safeShop.id,{userId:"owner"})).toMatchObject({ok:true})
  const replay=await executeApproval(actionDb("second-action"),"second-action",safeShop.id,{userId:"owner"})
  expect.soft(replay).toMatchObject({ok:false})
  expect(sendOutboundSms).toHaveBeenCalledTimes(1)
 } finally {vi.unstubAllEnvs()}
})
