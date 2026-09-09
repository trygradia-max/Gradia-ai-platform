import { afterEach,it,expect,vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createOwnerQuote } from "@/app/actions/quotes"
import { loadPublicQuote } from "@/app/actions/quote-response"
import { recordInteraction } from "@/lib/memory"
import { readDb } from "./_tenant-fixtures"
let db: SupabaseClient
vi.mock("@/lib/shop",()=>({requireShop:async()=>({id:"shop"}),requireUser:async()=>({id:"owner"})}))
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>db}))
vi.mock("@/lib/supabase/service",()=>({createServiceClient:()=>db}))
vi.mock("@/lib/memory",()=>({recordInteraction:vi.fn()}))
const customerId="12345678-1234-4234-9234-123456789abc"
const otherId="12345678-1234-4234-9234-123456789abd"
afterEach(()=>vi.clearAllMocks())
it.each(["customer","vehicle","lead"])("owner quote rejects foreign %s before writes",async kind=>{
  const input={customerId,selections:[{serviceId:otherId,multiplierKeys:[]}],...(kind === "vehicle"?{vehicleId:otherId}:{}),...(kind === "lead"?{leadId:otherId}:{})}
  db=readDb({customers:[{id:customerId,shop_id:kind === "customer"?"foreign":"shop"}],vehicles:[{id:otherId,shop_id:"foreign",customer_id:customerId}],leads:[{id:otherId,shop_id:"foreign",customer_id:customerId}]}).db
  expect(await createOwnerQuote(input)).toMatchObject({ok:false,error:"Quote references could not be verified for this customer and shop."})
  expect(recordInteraction).not.toHaveBeenCalled()
})
it("public quote returns no data for a corrupt foreign-customer graph",async()=>{
  const token="123456789abcdef123456789abcdef123"
  db=readDb({quotes:[{id:otherId,shop_id:"shop",public_token:token,customer_id:customerId,customers:{name:"must not escape"},status:"sent"}],customers:[{id:customerId,shop_id:"foreign"}]}).db
  expect(await loadPublicQuote(token)).toBeNull();expect(recordInteraction).not.toHaveBeenCalled()
})
