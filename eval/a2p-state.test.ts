import { describe, expect, it } from "vitest"
import { describeA2pRegistration, sameBusinessDetails } from "@/lib/a2p-state"

const row = (patch: Record<string, unknown>) => ({ status: "draft", failed_step: null, retryable: null, failure_reason: null, attempts: 1, ...patch }) as Parameters<typeof describeA2pRegistration>[0]

describe("SMS registration state the owner sees", () => {
  it("names one next action for every stored state", () => {
    expect(describeA2pRegistration(null).nextAction).toBe("submit")
    expect(describeA2pRegistration(row({})).nextAction).toBe("submit")
    expect(describeA2pRegistration(row({ failed_step: "trust_product", retryable: true })).nextAction).toBe("resume")
    expect(describeA2pRegistration(row({ failed_step: "brand", retryable: false })).nextAction).toBe("fix_and_resubmit")
    expect(describeA2pRegistration(row({ status: "brand_pending" })).nextAction).toBe("wait")
    expect(describeA2pRegistration(row({ status: "brand_pending", failed_step: "campaign", retryable: true })).nextAction).toBe("wait")
    expect(describeA2pRegistration(row({ status: "campaign_pending" })).nextAction).toBe("wait")
    expect(describeA2pRegistration(row({ status: "rejected", failed_step: "brand", retryable: false })).nextAction).toBe("fix_and_resubmit")
    expect(describeA2pRegistration(row({ status: "rejected", failed_step: "campaign", retryable: false })).nextAction).toBe("resubmit_campaign")
    expect(describeA2pRegistration(row({ status: "approved" })).nextAction).toBe("none")
  })
  it("carries the failed step, whether retrying can fix it, and the reason", () => {
    expect(describeA2pRegistration(row({ failed_step: "brand", retryable: false, failure_reason: "EIN mismatch", attempts: 2 })))
      .toEqual({ status: "draft", nextAction: "fix_and_resubmit", failedStep: "brand", retryable: false, failureReason: "EIN mismatch", attempts: 2 })
  })
  it("compares business details regardless of key order", () => {
    expect(sameBusinessDetails({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true)
    expect(sameBusinessDetails({ a: 1 }, { a: 2 })).toBe(false)
  })
})
