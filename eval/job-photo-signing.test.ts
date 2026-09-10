import { afterEach, it, expect, vi } from "vitest"
import { getJobPhotoUrls, uploadJobPhoto } from "@/app/actions/jobs"
import { createServiceClient } from "@/lib/supabase/service"
import { readDb } from "./_tenant-fixtures"
import type { SupabaseClient } from "@supabase/supabase-js"
let db: SupabaseClient
const signed = vi.hoisted(() => vi.fn(async () => ({data:{signedUrl:"synthetic-signed-url"},error:null})))
vi.mock("@/lib/shop",()=>({requireShop:async()=>({id:"shop"})}))
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>db}))
vi.mock("@/lib/supabase/service",()=>({createServiceClient:vi.fn(()=>({storage:{from:()=>({createSignedUrl:signed})}}))}))
const path="shop/job/before-12345678-1234-4234-9234-123456789abc.jpg"
afterEach(()=>vi.clearAllMocks())
it.each(["other/job/before-12345678-1234-4234-9234-123456789abc.jpg","shop/other/before-12345678-1234-4234-9234-123456789abc.jpg","shop/job/../private.jpg"])("signs nothing when even one stored path is invalid: %s",async bad=>{
  db=readDb({appointments:[{id:"job",shop_id:"shop",photos_before:[path,bad],photos_after:[]}]}).db
  expect(await getJobPhotoUrls("job")).toEqual({before:[],after:[]})
  expect(createServiceClient).not.toHaveBeenCalled();expect(signed).not.toHaveBeenCalled()
})
it("cannot sign a foreign appointment",async()=>{
  db=readDb({appointments:[{id:"job",shop_id:"foreign",photos_before:[path],photos_after:[]}]}).db
  expect(await getJobPhotoUrls("job")).toEqual({before:[],after:[]});expect(signed).not.toHaveBeenCalled()
})
it("signs a valid owned appointment path",async()=>{
  db=readDb({appointments:[{id:"job",shop_id:"shop",photos_before:[path],photos_after:[]}]}).db
  expect(await getJobPhotoUrls("job")).toEqual({before:["synthetic-signed-url"],after:[]})
  expect(signed).toHaveBeenCalledExactlyOnceWith(path,3600)
})

it.each(["BEFORE", "After", "before|after", ".*", "", null])("invalid upload phase %s has no effects", async phase => {
  const from = vi.fn(() => { throw new Error("Database must not be reached") })
  db = {from} as unknown as SupabaseClient
  expect(await uploadJobPhoto("job", phase as "before", new FormData())).toEqual({ok:false,error:"Photo phase must be before or after."})
  expect(from).not.toHaveBeenCalled()
  expect(createServiceClient).not.toHaveBeenCalled()
  expect(signed).not.toHaveBeenCalled()
})

it("rejects noncanonical appointment identity before storage or database access",async()=>{
 const from=vi.fn(()=>{throw new Error("Database must not be reached")});db={from} as unknown as SupabaseClient
 expect(await uploadJobPhoto("AAAAAAAA-1234-4234-9234-123456789abc","before",new FormData())).toEqual({ok:false,error:"Appointment ID must be canonical."})
 expect(from).not.toHaveBeenCalled();expect(createServiceClient).not.toHaveBeenCalled();expect(signed).not.toHaveBeenCalled()
})
it("signs nothing when a stored photo has a mismatched phase",async()=>{
 db=readDb({appointments:[{id:"job",shop_id:"shop",photos_before:[path.replace("before-","after-")],photos_after:[]}]}).db
 expect(await getJobPhotoUrls("job")).toEqual({before:[],after:[]})
 expect(createServiceClient).not.toHaveBeenCalled();expect(signed).not.toHaveBeenCalled()
})
it("rejects uppercase UUIDs in stored photo filenames before signing",async()=>{
 const uppercase=path.replace("123456789abc","123456789ABC")
 db=readDb({appointments:[{id:"job",shop_id:"shop",photos_before:[uppercase],photos_after:[]}]}).db
 const result=await getJobPhotoUrls("job")
 expect.soft(result).toEqual({before:[],after:[]})
 expect.soft(createServiceClient).not.toHaveBeenCalled()
 expect(signed).not.toHaveBeenCalled()
})
