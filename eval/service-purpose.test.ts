import {beforeAll,afterAll,it,expect,vi} from "vitest"
import {readDb,safeCustomer,safeShop} from "./_tenant-fixtures"
import {issueServiceProof,verifyServiceProof,servicePayload} from "@/lib/service-purpose"
import {evaluateCustomerSendPolicy} from "@/lib/send-policy"
const message={shopId:safeShop.id,customerId:safeCustomer.id,channel:"email" as const,destination:safeCustomer.email,body:"Your appointment is confirmed",subject:"Confirmation"}
const appointment={id:"appointment",shop_id:safeShop.id,customer_id:safeCustomer.id}
beforeAll(()=>vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-unit-purpose-signing-material"))
afterAll(()=>vi.unstubAllEnvs())
it("a category alone never grants transactional permission; edits and cross-tenant proofs fail",async()=>{
 const {db}=readDb({customers:[safeCustomer],appointments:[appointment]})
 const input={channel:message.channel,destination:message.destination,customerId:message.customerId,body:message.body,subject:message.subject,category:"transactional" as const}
 expect(await evaluateCustomerSendPolicy(db,safeShop,input)).toMatchObject({allowed:false,held:true,reason:expect.stringContaining("Service purpose could not be verified")})
 const proof=await issueServiceProof(db,message,{kind:"appointment",id:appointment.id})
 expect(proof).toBeTruthy()
 expect(await evaluateCustomerSendPolicy(db,safeShop,{...input,serviceProof:proof})).toMatchObject({allowed:true})
 for(const patch of [{body:"Buy this promotion"},{destination:"other@example.test"},{customerId:"foreign"},{shopId:"foreign"},{subject:"Sale"}]) expect(await verifyServiceProof(db,{...message,...patch},proof)).toBe(false)
 expect(await verifyServiceProof(readDb({appointments:[]}).db,message,proof)).toBe(false)
 expect(await verifyServiceProof(db,message,"forged")).toBe(false)
})
it("only a recent inbound conversation belonging to the exact recipient can authorize a reply",async()=>{
 const inbound={id:"inbound",shop_id:safeShop.id,customer_id:safeCustomer.id,channel:"email",role:"customer",created_at:new Date().toISOString(),metadata:{direction:"inbound",from_email:safeCustomer.email}}
 for(const patch of [{},{shop_id:"foreign"},{customer_id:"foreign"},{channel:"sms"},{role:"gradia"},{created_at:"2020-01-01"},{metadata:{direction:"inbound",from_email:"foreign@example.test"}}]) {
  const {db}=readDb({interactions:[{...inbound,...patch}]})
  expect(Boolean(await issueServiceProof(db,message,{kind:"reply",id:inbound.id}))).toBe(Object.keys(patch).length===0)
 }
})
it("arbitrary proposals cannot acquire proof merely by declaring a transactional category",async()=>{
 const {db}=readDb({customers:[safeCustomer],appointments:[appointment]})
 const payload=await servicePayload(db,safeShop.id,{category:"transactional",customer_id:safeCustomer.id,to_email:safeCustomer.email,body:"Unrequested promotion",source:"operator_propose"})
 expect(payload.service_proof).toBeNull()
})
it("expired proofs and a substituted conversation context fail closed",async()=>{
 const now=Date.now()
 const clock=vi.spyOn(Date,"now").mockReturnValue(now)
 try {
  const {db}=readDb({customers:[safeCustomer],appointments:[appointment]})
  const proof=await issueServiceProof(db,message,{kind:"appointment",id:appointment.id})
  expect(proof).toBeTruthy()
  const decoded=JSON.parse(Buffer.from(proof!,"base64url").toString())
  decoded.context={kind:"reply",id:"different-conversation"}
  expect(await verifyServiceProof(db,message,Buffer.from(JSON.stringify(decoded)).toString("base64url"))).toBe(false)
  clock.mockReturnValue(now+24*60*60*1000+1)
  expect(await verifyServiceProof(db,message,proof)).toBe(false)
  expect(await evaluateCustomerSendPolicy(db,safeShop,{channel:message.channel,destination:message.destination,customerId:message.customerId,body:message.body,subject:message.subject,category:"transactional",serviceProof:proof})).toMatchObject({allowed:false,held:true})
 } finally {clock.mockRestore()}
})
