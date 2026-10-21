import { describe, expect, it } from "vitest"
import { projectOperationsQueue, type OperationsAction } from "@/lib/operations-queue"

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
