import {it,expect,vi,afterEach} from "vitest"
import type {SupabaseClient} from "@supabase/supabase-js"
import {reviewCommunicationPurpose} from "@/app/actions/approvals"
import {readDb,safeCustomer,safeShop} from "./_tenant-fixtures"
let db:SupabaseClient
const id="12345678-1234-4234-9234-123456789abc"
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}))
vi.mock("@/lib/shop",()=>({requireUser:async()=>({id:"owner"}),requireShop:async()=>safeShop}))
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>db}))
afterEach(()=>vi.unstubAllEnvs())
function fixture(foreign=false,inbound=false) {
 const writes:Record<string,unknown>[]=[]
 const original={customer_id:safeCustomer.id,to_email:safeCustomer.email,body:"Reply",subject:"Service",category:"transactional",quote_id:"forged-context"}
 const {db:reads}=readDb({customers:[safeCustomer],interactions:inbound?[{id:"inbound",shop_id:safeShop.id,customer_id:safeCustomer.id,channel:"email",role:"customer",created_at:new Date().toISOString(),metadata:{direction:"inbound",from_email:safeCustomer.email}}]:[]})
 const pending={select:()=>pending,eq:()=>pending,in:()=>pending,update:(value:Record<string,unknown>)=>{writes.push(value);return pending},maybeSingle:async()=>({data:writes.length?{id}:{id,shop_id:foreign?"foreign":safeShop.id,action_type:"send_email",status:"pending",payload:original},error:null})}
 db={from:(table:string)=>table==="pending_actions"?pending:reads.from(table)} as unknown as SupabaseClient
 return writes
}
it("cannot reclassify a foreign-shop action",async()=>{
 const writes=fixture(true)
 expect(await reviewCommunicationPurpose(id,"marketing")).toEqual({ok:false,error:"Pending customer message could not be verified."})
 expect(writes).toHaveLength(0)
})
it("caller-editable quote context cannot become verified reply authority",async()=>{
 const writes=fixture()
 expect(await reviewCommunicationPurpose(id,"reply")).toMatchObject({ok:false,error:expect.stringContaining("no verified inbound conversation")})
 expect(writes).toHaveLength(0)
})
it("explicit marketing review clears transactional authority and records reviewer",async()=>{
 const writes=fixture()
 expect(await reviewCommunicationPurpose(id,"marketing")).toMatchObject({ok:true})
 expect(writes).toEqual([{payload:expect.objectContaining({category:"marketing",service_proof:null,purpose_review:expect.objectContaining({by:"owner",purpose:"marketing"})})}])
})
it("verified reply review binds existing content to its recent inbound context",async()=>{
 vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-purpose-review-signing-material")
 const writes=fixture(false,true)
 expect(await reviewCommunicationPurpose(id,"reply")).toMatchObject({ok:true})
 expect(writes[0].payload).toMatchObject({category:"transactional",service_proof:expect.any(String),purpose_review:expect.objectContaining({purpose:"reply"})})
})
