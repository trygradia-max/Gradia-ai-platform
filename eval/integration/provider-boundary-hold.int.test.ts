import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { recordBoundaryHold, type RecordHoldInput } from "@/lib/provider-boundary/hold"
import {
  INTEGRATION_WITH_SESSION,
  cleanup,
  ownerSessionClient,
  seedShop,
  serviceClient,
  type Seeded,
} from "./_db"

const PASSWORD = "Synthetic-password-123!"

describe.skipIf(!INTEGRATION_WITH_SESSION)("provider boundary hold marker is durably unique", () => {
  let db: SupabaseClient
  let a: Seeded
  let b: Seeded
  let customerA: string

  const input = (over: Partial<RecordHoldInput> = {}): RecordHoldInput => ({
    shopId: a.shopId,
    customerId: null,
    channel: "email",
    stage: "classify",
    sourceRef: `msg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    reasons: ["override_role"],
    ...over,
  })

  const markers = async (shopId: string, sourceRef?: string) => {
    let q = db.from("interactions").select("id, channel, content, metadata, customer_id")
      .eq("shop_id", shopId).eq("role", "system").eq("metadata->>kind", "hold")
    if (sourceRef) q = q.like("metadata->>boundary_hold_key", `%:${sourceRef}`)
    const { data, error } = await q
    expect(error).toBeNull()
    return data ?? []
  }

  beforeAll(async () => {
    db = serviceClient()
    a = await seedShop(db, { password: PASSWORD })
    b = await seedShop(db, { password: PASSWORD })
    const { data, error } = await db.from("customers").insert({ shop_id: a.shopId, name: "Fictional Customer" }).select("id").single()
    expect(error).toBeNull()
    customerA = data!.id as string
  })

  afterAll(async () => {
    await cleanup(db, a)
    await cleanup(db, b)
  })

  it("simultaneous duplicate deliveries write exactly one marker", async () => {
    const i = input()
    const results = await Promise.all(Array.from({ length: 24 }, () => recordBoundaryHold(db, i)))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.filter((r) => r.ok && r.recorded)).toHaveLength(1)
    expect(await markers(a.shopId, i.sourceRef)).toHaveLength(1)
  })

  it("a sequential replay is a no-op and the marker stays content-free", async () => {
    const i = input({ channel: "sms", sourceRef: `SM${Date.now()}` })
    expect(await recordBoundaryHold(db, i)).toEqual({ ok: true, recorded: true })
    expect(await recordBoundaryHold(db, i)).toEqual({ ok: true, recorded: false })
    const rows = await markers(a.shopId, i.sourceRef)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("Held for human review: this message was not classified or answered automatically.")
    expect(rows[0].metadata).toEqual({
      source: "provider_boundary", kind: "hold", stage: "classify",
      boundary_hold_key: `classify:${i.sourceRef}`, reasons: ["override_role"],
    })
  })

  it("stage, channel and shop each get their own marker for the same source ref", async () => {
    const ref = `shared-${Date.now()}`
    const writes = await Promise.all([
      recordBoundaryHold(db, input({ sourceRef: ref, stage: "classify", channel: "email" })),
      recordBoundaryHold(db, input({ sourceRef: ref, stage: "draft", channel: "email" })),
      recordBoundaryHold(db, input({ sourceRef: ref, stage: "classify", channel: "sms" })),
      recordBoundaryHold(db, input({ sourceRef: ref, stage: "classify", channel: "email", shopId: b.shopId })),
    ])
    expect(writes).toEqual(Array(4).fill({ ok: true, recorded: true }))
    expect(await markers(a.shopId, ref)).toHaveLength(3)
    expect(await markers(b.shopId, ref)).toHaveLength(1)
  })

  it("concurrent writers with different customer attribution still produce one marker", async () => {
    const ref = `cust-${Date.now()}`
    const results = await Promise.all(
      [null, customerA, null, customerA, null, customerA].map((customerId) =>
        recordBoundaryHold(db, input({ sourceRef: ref, customerId })),
      ),
    )
    expect(results.filter((r) => r.ok && r.recorded)).toHaveLength(1)
    expect(await markers(a.shopId, ref)).toHaveLength(1)
  })

  it("does not touch other interaction rows (raw evidence, ordinary system notes) with the same key text", async () => {
    const ref = `raw-${Date.now()}`
    const evidence = { shop_id: a.shopId, channel: "email", role: "customer", content: "raw customer words", metadata: { boundary_hold_key: `classify:${ref}` } }
    for (let n = 0; n < 2; n++) {
      const { error } = await db.from("interactions").insert(evidence)
      expect(error).toBeNull()
    }
    const unrelated = { shop_id: a.shopId, channel: "email", role: "system", content: "ordinary note", metadata: { boundary_hold_key: `classify:${ref}` } }
    for (let n = 0; n < 2; n++) {
      const { error } = await db.from("interactions").insert(unrelated)
      expect(error).toBeNull()
    }
    expect(await recordBoundaryHold(db, input({ sourceRef: ref }))).toEqual({ ok: true, recorded: true })
  })

  it("a marker is tenant-scoped under RLS and removed with its customer and shop", async () => {
    const ref = `rls-${Date.now()}`
    expect(await recordBoundaryHold(db, input({ sourceRef: ref, customerId: customerA }))).toEqual({ ok: true, recorded: true })
    const ownerA = await ownerSessionClient(a.email, PASSWORD)
    const ownerB = await ownerSessionClient(b.email, PASSWORD)
    const seen = async (c: SupabaseClient) =>
      (await c.from("interactions").select("id").eq("metadata->>boundary_hold_key", `classify:${ref}`)).data ?? []
    expect(await seen(ownerA)).toHaveLength(1)
    expect(await seen(ownerB)).toHaveLength(0)

    // Another tenant cannot pre-claim or collide with this shop's key.
    expect(await recordBoundaryHold(db, input({ sourceRef: ref, shopId: b.shopId }))).toEqual({ ok: true, recorded: true })

    // Customer delete cascades the marker (interactions.customer_id ON DELETE CASCADE).
    await db.from("customers").delete().eq("id", customerA)
    expect(await markers(a.shopId, ref)).toHaveLength(0)
    expect(await markers(b.shopId, ref)).toHaveLength(1)
  })
})
