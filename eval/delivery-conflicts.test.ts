import { describe, expect, it } from "vitest"
import { smsDeliveryState } from "@/lib/twilio-delivery-status"
import { conflictResolutionCommandSchema, readDeliveryConflicts } from "@/lib/delivery-reconciliation"

describe("terminal delivery conflicts read truthfully", () => {
  it("a message with a recorded conflicting outcome is conflicting, never delivered", () => {
    expect(smsDeliveryState({ twilio_status: "delivered", twilio_status_conflict: { status: "failed", error_code: "30008" } }))
      .toEqual({ state: "conflicting", recorded: "delivered", conflict: "failed", errorCode: null, conflictErrorCode: "30008" })
    expect(smsDeliveryState({ twilio_status: "undelivered", twilio_error_code: "30003", twilio_status_conflict: { status: "delivered" } }).state).toBe("conflicting")
    expect(smsDeliveryState({ twilio_status: "delivered" }).state).toBe("delivered")
    expect(smsDeliveryState({ twilio_status: "failed", twilio_error_code: 30007 })).toEqual({ state: "failed", errorCode: "30007" })
    expect(smsDeliveryState(null).state).toBe("unknown")
  })
  it("a refused or malformed conflict read is unavailable, never an empty all-clear", async () => {
    const db = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) })
    expect(await readDeliveryConflicts(db(null, { message: "denied" }), "00000000-0000-4000-8000-000000000000")).toEqual({ state: "unavailable" })
    expect(await readDeliveryConflicts(db({ viewer_role: "owner", items: [{ delivery_state: "delivered" }] }), "00000000-0000-4000-8000-000000000000")).toEqual({ state: "unavailable" })
    expect(await readDeliveryConflicts(db({ viewer_role: "owner", items: [] }), "00000000-0000-4000-8000-000000000000")).toEqual({ state: "ok", viewerRole: "owner", items: [] })
  })
  it("the resolution command needs a reason and the conflict the reviewer saw", () => {
    const ok = { shopId: "00000000-0000-4000-8000-000000000000", interactionId: "00000000-0000-4000-8000-000000000001", commandId: "00000000-0000-4000-8000-000000000002", revision: 0, conflictReceivedAt: "2026-10-21T00:00:00.000Z", outcome: "not_delivered", note: "Checked the carrier log." }
    expect(conflictResolutionCommandSchema.safeParse(ok).success).toBe(true)
    expect(conflictResolutionCommandSchema.safeParse({ ...ok, note: "short" }).success).toBe(false)
    expect(conflictResolutionCommandSchema.safeParse({ ...ok, conflictReceivedAt: "" }).success).toBe(false)
    expect(conflictResolutionCommandSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })
})
