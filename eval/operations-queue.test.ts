import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { projectOperationsQueue, type OperationsAction } from "@/lib/operations-queue"
import { readOperationsQueuePage } from "@/lib/operations-queue-reader"

const action = (patch: Partial<OperationsAction> = {}): OperationsAction => ({
  id: "action-1", shop_id: "shop-1", action_type: "send_sms", status: "pending",
  result_id: null, created_at: "2026-10-21T12:00:00Z", delivery: { state: "unspent" },
  deliveryConflict: false, ...patch,
})
const queue = (...actions: OperationsAction[]) => projectOperationsQueue("shop-1", { status: "ready", actions, hasMore: true })
describe("operations queue evidence boundary", () => {
  it("does not turn source failure into an empty success", () => {
    expect(projectOperationsQueue("shop-1", {status: "unavailable"}).status).toBe("unavailable")
  })
  it("rejects a mixed tenant source rather than leaking a partial result", () => {
    expect(queue(action(), action({shop_id: "shop-2"}))).toEqual({status: "unavailable", items: [], reason: "scope_mismatch"})
  })
  it("keeps loaded window counts distinct from totals", () => {
    expect(queue(action())).toMatchObject({hasMore: true, countsInLoadedWindow: {needsReview: 1, outcomeUnconfirmed: 0}})
  })
  it("does not treat approval as completion", () => {
    expect(queue(action({status: "approved"})).items[0].state).toBe("outcome_unconfirmed")
  })
  it.each(["pending", "rejected", "approved"] as const)("preserves uncertain claimed sends in %s", status => {
    expect(queue(action({status, delivery: {state: "claimed", claimedAt: "2026-10-21T12:00:00Z", completedAt: null}})).items[0].state).toBe("outcome_unconfirmed")
  })
  it("does not expose normal review when message evidence cannot be read", () => {
    expect(queue(action({delivery: {state: "unavailable"}})).items[0].state).toBe("outcome_unconfirmed")
  })
  it("keeps terminal provider conflicts visible despite an execution result", () => {
    expect(queue(action({status: "approved", result_id: "result", deliveryConflict: true})).items).toHaveLength(1)
  })
  it("omits completed execution and rejected unattempted work without claiming delivery", () => {
    expect(queue(action({status: "approved", result_id: "result"}), action({status: "rejected"})).items).toEqual([])
  })
  it("does not copy customer payloads into the queue", () => {
    const result = queue({...action(), payload: {body: "private"}} as OperationsAction)
    expect(JSON.stringify(result)).not.toContain("private")
  })
})

describe("operations queue authorized reader", () => {
  const shopId = randomUUID()
  const row = (patch: Record<string, unknown> = {}) => ({
    id: randomUUID(), shop_id: shopId, action_type: "send_sms", status: "pending",
    result_id: null, created_at: "2026-10-21T12:00:00.000Z", delivery_state: "unspent",
    claimed_at: null, completed_at: null, delivery_conflict: false, ...patch,
  })
  const client = (data: unknown, error: unknown = null) => ({
    rpc: async () => ({ data, error }),
  }) as never

  it("turns refused, thrown, and malformed reads into unavailable", async () => {
    expect(await readOperationsQueuePage(client(null, { message: "denied" }), shopId))
      .toMatchObject({ status: "unavailable" })
    expect(await readOperationsQueuePage(client({ viewer_role: "owner", items: [{ payload: "private" }] }), shopId))
      .toMatchObject({ status: "unavailable" })
    const thrown = { rpc: async () => { throw new Error("offline") } } as never
    expect(await readOperationsQueuePage(thrown, shopId)).toMatchObject({ status: "unavailable" })
  })

  it("returns a minimal stable page and cursor without copying source payloads", async () => {
    const rows = [row({ created_at: "2026-10-21T12:02:00.000Z" }), row({ created_at: "2026-10-21T12:01:00.000Z" }), row()]
    const result = await readOperationsQueuePage(client({ viewer_role: "owner", items: rows }), shopId, { limit: 2 })
    expect(result).toMatchObject({ status: "ready", viewerRole: "owner", hasMore: true, nextCursor: { createdAt: rows[1].created_at, sourceId: rows[1].id } })
    expect(result.items.map((item) => item.sourceId)).toEqual(rows.slice(0, 2).map((item) => item.id))
    expect(JSON.stringify(result)).not.toContain("payload")
  })

  it("keeps unreadable evidence and conflicts unresolved", async () => {
    const unavailable = row({ delivery_state: "claimed", claimed_at: null })
    expect(await readOperationsQueuePage(client({ viewer_role: "owner", items: [unavailable] }), shopId))
      .toMatchObject({ status: "unavailable" })
    const conflict = row({ status: "approved", result_id: randomUUID(), delivery_state: "provider_accepted", claimed_at: "2026-10-21T12:00:00.000Z", completed_at: "2026-10-21T12:00:01.000Z", delivery_conflict: true })
    const result = await readOperationsQueuePage(client({ viewer_role: "manager", items: [conflict] }), shopId)
    expect(result).toMatchObject({ status: "ready", viewerRole: "manager", items: [{ state: "outcome_unconfirmed" }] })
  })

  it("rejects invalid scope, cursor, and page sizes before calling the database", async () => {
    let calls = 0
    const db = { rpc: async () => { calls++; return { data: null, error: null } } } as never
    expect((await readOperationsQueuePage(db, "not-a-shop")).status).toBe("unavailable")
    expect((await readOperationsQueuePage(db, shopId, { limit: 51 })).status).toBe("unavailable")
    expect((await readOperationsQueuePage(db, shopId, { cursor: { createdAt: "no", sourceId: randomUUID() } })).status).toBe("unavailable")
    expect(calls).toBe(0)
  })
})
