import {afterEach,it,expect,vi} from "vitest"
import {issueServiceProof,claimServiceExecution,verifyServiceProof} from "@/lib/service-purpose"
import {readDb,safeCustomer,safeShop} from "./_tenant-fixtures"
const message={shopId:safeShop.id,customerId:safeCustomer.id,channel:"sms" as const,destination:safeCustomer.phone,body:"Appointment confirmed"}
const context={kind:"appointment" as const,id:"appointment"}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})
async function fixture() {
 vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-proof-claim-signing-material")
 const {db}=readDb({appointments:[{id:context.id,shop_id:message.shopId,customer_id:message.customerId}]})
 const rpc=vi.fn(async()=>({data:"claimed",error:null}));Object.assign(db,{rpc})
 const proof=(await issueServiceProof(db,message,context))!
 return {db,rpc,proof}
}
it("forged, mismatched, edited and expired proofs never reach the claim RPC",async()=>{
 const {db,rpc,proof}=await fixture()
 for(const patch of [{shopId:"foreign"},{customerId:"foreign"},{destination:"+15559999999"},{body:"Promotion"},{channel:"email" as const}])expect(await claimServiceExecution(db,{...message,...patch},proof)).toMatchObject({ok:false})
 expect(await claimServiceExecution(db,message,"forged")).toMatchObject({ok:false})
 for(const patch of [{context:{kind:"reply",id:"other"}},{purpose:"marketing"},{nonce:"00000000-0000-4000-8000-000000000001"}]){
  const edited=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(proof,"base64url").toString()),...patch})).toString("base64url")
  expect(await claimServiceExecution(db,message,edited)).toMatchObject({ok:false})
 }
 vi.spyOn(Date,"now").mockReturnValue(Date.now()+25*60*60*1000)
 expect(await claimServiceExecution(db,message,proof)).toMatchObject({ok:false})
 expect(rpc).not.toHaveBeenCalled()
})
it("thrown claim errors and missing success cannot authorize execution",async()=>{
 const {db,rpc,proof}=await fixture()
 rpc.mockRejectedValueOnce(new Error("offline"))
 expect(await claimServiceExecution(db,message,proof)).toMatchObject({ok:false})
 rpc.mockResolvedValueOnce({data:"",error:null})
 expect(await claimServiceExecution(db,message,proof)).toMatchObject({ok:false})
})
it("proof IDs are unique and normalized content remains bound",async()=>{
 const {db,proof}=await fixture(),other=await issueServiceProof(db,message,context)
 expect(JSON.parse(Buffer.from(proof,"base64url").toString()).nonce).not.toBe(JSON.parse(Buffer.from(other!,"base64url").toString()).nonce)
 const composed={...message,body:"Café\nConfirmed"},normalized=await issueServiceProof(db,composed,context)
 expect(await verifyServiceProof(db,{...composed,body:"Cafe\u0301\r\nConfirmed"},normalized)).toBe(true)
 expect(await verifyServiceProof(db,{...composed,body:composed.body+" "},normalized)).toBe(false)
})
