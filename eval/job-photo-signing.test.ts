import { afterEach, it, expect, vi } from "vitest"
import { getJobPhotoUrls, uploadJobPhoto } from "@/app/actions/jobs"
import { createServiceClient } from "@/lib/supabase/service"
import { readDb } from "./_tenant-fixtures"
import type { SupabaseClient } from "@supabase/supabase-js"
let db: SupabaseClient
const signed = vi.hoisted(() => vi.fn(async () => ({data:{signedUrl:"synthetic-signed-url"},error:null})))
vi.mock("@/lib/shop",()=>({requireShop:async()=>({id:"aaaaaaaa-1234-4234-9234-123456789abc"})}))
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>db}))
vi.mock("@/lib/supabase/service",()=>({createServiceClient:vi.fn(()=>({storage:{from:()=>({createSignedUrl:signed})}}))}))
const path="aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/before-12345678-1234-4234-9234-123456789abc.jpg"
afterEach(()=>vi.clearAllMocks())
it.each(["cccccccc-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/before-12345678-1234-4234-9234-123456789abc.jpg","aaaaaaaa-1234-4234-9234-123456789abc/cccccccc-1234-4234-9234-123456789abc/before-12345678-1234-4234-9234-123456789abc.jpg","aaaaaaaa-1234-4234-9234-123456789abc/bbbbbbbb-1234-4234-9234-123456789abc/../private.jpg"])("signs nothing when even one stored path is invalid: %s",async bad=>{
  db=readDb({appointments:[{id:"bbbbbbbb-1234-4234-9234-123456789abc",shop_id:"aaaaaaaa-1234-4234-9234-123456789abc",photos_before:[path,bad],photos_after:[]}]}).db
  expect(await getJobPhotoUrls("bbbbbbbb-1234-4234-9234-123456789abc")).toEqual({before:[],after:[],error:"Photo paths are invalid. Review the appointment photos before retrying."})
  expect(createServiceClient).not.toHaveBeenCalled();expect(signed).not.toHaveBeenCalled()
})
it("cannot sign a foreign appointment",async()=>{
  db=readDb({appointments:[{id:"bbbbbbbb-1234-4234-9234-123456789abc",shop_id:"foreign",photos_before:[path],photos_after:[]}]}).db
  expect(await getJobPhotoUrls("bbbbbbbb-1234-4234-9234-123456789abc")).toEqual({before:[],after:[]});expect(signed).not.toHaveBeenCalled()
})
it("signs a valid owned appointment path",async()=>{
  db=readDb({appointments:[{id:"bbbbbbbb-1234-4234-9234-123456789abc",shop_id:"aaaaaaaa-1234-4234-9234-123456789abc",photos_before:[path],photos_after:[]}]}).db
  expect(await getJobPhotoUrls("bbbbbbbb-1234-4234-9234-123456789abc")).toEqual({before:["synthetic-signed-url"],after:[]})
  expect(signed).toHaveBeenCalledExactlyOnceWith(path,3600)
})

it.each(["BEFORE", "After", "before|after", ".*", "", null])("invalid upload phase %s has no effects", async phase => {
  const from = vi.fn(() => { throw new Error("Database must not be reached") })
  db = {from} as unknown as SupabaseClient
  expect(await uploadJobPhoto("bbbbbbbb-1234-4234-9234-123456789abc", phase as "before", new FormData())).toEqual({ok:false,error:"Photo phase must be before or after."})
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
 db=readDb({appointments:[{id:"bbbbbbbb-1234-4234-9234-123456789abc",shop_id:"aaaaaaaa-1234-4234-9234-123456789abc",photos_before:[path.replace("before-","after-")],photos_after:[]}]}).db
 expect(await getJobPhotoUrls("bbbbbbbb-1234-4234-9234-123456789abc")).toEqual({before:[],after:[],error:"Photo paths are invalid. Review the appointment photos before retrying."})
 expect(createServiceClient).not.toHaveBeenCalled();expect(signed).not.toHaveBeenCalled()
})
it("rejects uppercase UUIDs in stored photo filenames before signing",async()=>{
 const uppercase=path.replace("before-12345678-1234-4234-9234-123456789abc", "before-12345678-1234-4234-9234-123456789ABC")
 db=readDb({appointments:[{id:"bbbbbbbb-1234-4234-9234-123456789abc",shop_id:"aaaaaaaa-1234-4234-9234-123456789abc",photos_before:[uppercase],photos_after:[]}]}).db
 const result=await getJobPhotoUrls("bbbbbbbb-1234-4234-9234-123456789abc")
 expect.soft(result).toEqual({before:[],after:[],error:"Photo paths are invalid. Review the appointment photos before retrying."})
 expect.soft(createServiceClient).not.toHaveBeenCalled()
 expect(signed).not.toHaveBeenCalled()
})

it.each([0,1,2])("rejects uppercase UUID characters at path segment %s",async position=>{
 const segments=path.split("/")
 segments[position]=position===2?segments[position].replace("abc.jpg","ABC.jpg"):segments[position].toUpperCase()
 db=readDb({appointments:[{id:"bbbbbbbb-1234-4234-9234-123456789abc",shop_id:"aaaaaaaa-1234-4234-9234-123456789abc",photos_before:[segments.join("/")],photos_after:[]}]}).db
 expect(await getJobPhotoUrls("bbbbbbbb-1234-4234-9234-123456789abc")).toMatchObject({before:[],after:[],error:expect.stringContaining("Photo paths are invalid")})
 expect(createServiceClient).not.toHaveBeenCalled();expect(signed).not.toHaveBeenCalled()
})
it("rejects uppercase appointment input before even reading the database",async()=>{
 const from=vi.fn(()=>{throw new Error("must not read")});db={from} as unknown as SupabaseClient
 expect(await getJobPhotoUrls("BBBBBBBB-1234-4234-9234-123456789abc")).toMatchObject({before:[],after:[],error:expect.stringContaining("identity is invalid")})
 expect(from).not.toHaveBeenCalled();expect(createServiceClient).not.toHaveBeenCalled();expect(signed).not.toHaveBeenCalled()
})
