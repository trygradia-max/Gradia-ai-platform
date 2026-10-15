import { describe, it, expect, vi } from "vitest"
import { readDb, safeCustomer } from "./_tenant-fixtures"
import { ownedReference, validQuoteReferences, validTenantReferences } from "@/lib/tenant-references"
import { recordInteraction } from "@/lib/memory"
import { upsertCustomerVehicle } from "@/lib/vehicles"
import { embedText } from "@/lib/embeddings"
vi.mock("@/lib/embeddings", () => ({ embedText: vi.fn(), EMBEDDING_MODEL: "fake" }))
describe("tenant references", () => {
  it.each(["customers", "vehicles", "leads", "appointments", "quotes"] as const)("rejects foreign %s under a service-style client", async table => {
    const {db,reads} = readDb({[table]:[{id:"foreign",shop_id:"shop-2"}]})
    expect(await ownedReference(db,"shop-1",table,"foreign")).toBeNull()
    expect(reads[0].filters).toContainEqual(["shop_id","shop-1"])
  })
  it("validates the entire quote graph, including same-shop wrong-customer vehicles", async () => {
    for (const customerId of ["c1", "c2"]) {
      const {db} = readDb({customers:[safeCustomer],vehicles:[{id:"v1",shop_id:"shop-1",customer_id:customerId}],leads:[{id:"l1",shop_id:"shop-1",customer_id:"c1"}]})
      expect(await validQuoteReferences(db,"shop-1",{customer_id:"c1",vehicle_id:"v1",lead_id:"l1"})).toBe(customerId === "c1")
    }
  })
  it("allows nullable relationships but rejects malformed supplied IDs and lookup failures", async () => {
    const {db} = readDb({customers:[safeCustomer]},"customers")
    expect(await validTenantReferences(db,"shop-1",{customer_id:null})).toBe(true)
    expect(await validTenantReferences(db,"shop-1",{customer_id:"c1"})).toBe(false)
    expect(await validTenantReferences(db,"shop-1",{customer_id:{id:"c1"}})).toBe(false)
  })
  it("denies interaction before embedding or insertion", async () => {
    const {db} = readDb({customers:[{...safeCustomer,shop_id:"shop-2"}]})
    expect(await recordInteraction(db,{shopId:"shop-1",customerId:"c1",channel:"note",role:"system",content:"private"})).toMatchObject({ok:false})
    expect(embedText).not.toHaveBeenCalled()
  })
  it("denies vehicle parent before legacy update or insert", async () => {
    const {db} = readDb({customers:[{...safeCustomer,shop_id:"shop-2"}]})
    expect(await upsertCustomerVehicle(db,"shop-1","c1",{make:"Ford",model:"F150",year:2020,color:null})).toBeNull()
  })
})
