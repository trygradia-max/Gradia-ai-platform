import { afterEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readDb, safeCustomer, safeShop } from "./_tenant-fixtures"
import { executeApproval } from "@/lib/approvals"
import { sendOperatorSms } from "@/app/actions/outbound-sms"
import { sendOutboundSms } from "@/lib/twilio"
import { getAccessTokenForShop, sendEmailMessage } from "@/lib/aurinko"
import { sendOpsAlert } from "@/lib/alerts"
import { recordInteraction } from "@/lib/memory"
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
    expect(result).toMatchObject({ok:false,error:"Destination does not belong to the referenced customer."})
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
