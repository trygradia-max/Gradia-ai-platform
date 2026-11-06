import { describe, expect, it } from "vitest"

import {
  CHECKOUT_RETURN_TARGETS,
  COMMERCIAL_BILLING_STATES,
  COMMERCIAL_CATALOG_VERSION,
  COMMERCIAL_PLAN_KEY,
  FOUNDER_PILOT_PRICE,
  billingDto,
  buildCheckoutReturnUrls,
  evaluateBillingSnapshot,
  isReturnTarget,
  type BillingSnapshot,
} from "@/lib/commercial-billing"
import { checkoutRequestFingerprint } from "@/lib/commercial-billing-service"

const goodEvidence = {
  id: "ev1",
  derivedState: "active",
  providerStatus: "active",
  catalogVersion: COMMERCIAL_CATALOG_VERSION,
  planKey: COMMERCIAL_PLAN_KEY,
  priceLookupKey: FOUNDER_PILOT_PRICE.lookupKey,
  evidenceSource: "signed_webhook",
  livemode: false,
}
function snap(
  state: (typeof COMMERCIAL_BILLING_STATES)[number],
  patch: { account?: Partial<NonNullable<BillingSnapshot["account"]>>; evidence?: Partial<NonNullable<BillingSnapshot["evidence"]>> | null; attempt?: BillingSnapshot["attempt"]; reason?: string | null } = {}
): BillingSnapshot {
  return {
    account: {
      state,
      stateReason: patch.reason ?? null,
      catalogVersion: COMMERCIAL_CATALOG_VERSION,
      planKey: COMMERCIAL_PLAN_KEY,
      providerMode: "test",
      hasPlatformCustomer: true,
      version: 3,
      ...patch.account,
    },
    attempt: patch.attempt ?? null,
    evidence: patch.evidence === null ? null : state === "active" ? { ...goodEvidence, ...patch.evidence } : (patch.evidence ? { ...goodEvidence, ...patch.evidence } : null),
  }
}

describe("approved Founder Pilot price contract", () => {
  it("comes from the approved manifest, not from display text", () => {
    expect(FOUNDER_PILOT_PRICE).toEqual({
      lookupKey: "gradia_founder_pilot_2026_11_monthly",
      unitAmountCents: 19_900,
      interval: "month",
      currency: "usd",
    })
  })
  it("has exactly the nine fail-closed states", () => {
    expect([...COMMERCIAL_BILLING_STATES].sort()).toEqual(
      ["active", "canceled", "checkout_pending", "checkout_required", "incomplete", "past_due", "reconciliation_required", "unconfigured", "unknown"].sort()
    )
  })
})

describe("evaluateBillingSnapshot (fail closed)", () => {
  it("only reviewed, current-catalog active evidence is eligible", () => {
    const ok = evaluateBillingSnapshot(snap("active"))
    expect(ok).toEqual({ state: "active", eligibleToActivate: true, blockingReason: null })
  })

  it("an unreadable record is unknown, never 'no account' and never eligible", () => {
    expect(evaluateBillingSnapshot(null)).toEqual({ state: "unknown", eligibleToActivate: false, blockingReason: "billing_state_unavailable" })
  })

  it("no account means checkout is required", () => {
    expect(evaluateBillingSnapshot({ account: null, attempt: null, evidence: null })).toEqual({
      state: "checkout_required",
      eligibleToActivate: false,
      blockingReason: "checkout_required",
    })
  })

  it.each([
    ["checkout_required", "checkout_required"],
    ["past_due", "subscription_past_due"],
    ["canceled", "subscription_canceled"],
    ["incomplete", "subscription_incomplete"],
    ["unknown", "subscription_unknown"],
    ["unconfigured", "billing_unconfigured"],
    ["reconciliation_required", "reconciliation_required"],
  ] as const)("%s blocks with %s", (state, reason) => {
    const result = evaluateBillingSnapshot(snap(state))
    expect(result.eligibleToActivate).toBe(false)
    expect(result.state).toBe(state)
    expect(result.blockingReason).toBe(reason)
  })

  it("checkout_pending distinguishes an open session from one awaiting evidence", () => {
    const open = evaluateBillingSnapshot(
      snap("checkout_pending", { attempt: { id: "a", attemptNo: 1, status: "session_open", failureCode: null, sessionId: "cs_test_x" } })
    )
    expect(open.blockingReason).toBe("checkout_required")
    const done = evaluateBillingSnapshot(snap("checkout_pending", { reason: "checkout_completed_awaiting_evidence" }))
    expect(done.blockingReason).toBe("checkout_completed_awaiting_evidence")
    expect(open.eligibleToActivate || done.eligibleToActivate).toBe(false)
  })

  it("keeps the exact stored reconciliation reason", () => {
    expect(evaluateBillingSnapshot(snap("reconciliation_required", { reason: "stale_in_flight" })).blockingReason).toBe("stale_in_flight")
    expect(evaluateBillingSnapshot(snap("reconciliation_required", { reason: "duplicate_subscription" })).blockingReason).toBe("duplicate_subscription")
    // An unrecognised stored reason never leaks through as an unknown string.
    expect(evaluateBillingSnapshot(snap("reconciliation_required", { reason: "something_else" })).blockingReason).toBe("reconciliation_required")
  })

  it("a mismatched catalog or plan blocks, even for an 'active' account", () => {
    for (const account of [{ catalogVersion: "2025-01-01.v1" }, { planKey: "growth" }]) {
      const result = evaluateBillingSnapshot(snap("active", { account }))
      expect(result).toMatchObject({ eligibleToActivate: false, state: "reconciliation_required", blockingReason: "catalog_mismatch" })
    }
    const evidenceMismatch = evaluateBillingSnapshot(snap("active", { evidence: { catalogVersion: "2025-01-01.v1" } }))
    expect(evidenceMismatch).toMatchObject({ eligibleToActivate: false, blockingReason: "catalog_mismatch" })
  })

  it.each([
    ["missing evidence", { evidence: null }],
    ["non-active provider status", { evidence: { providerStatus: "trialing" } }],
    ["derived state not active", { evidence: { derivedState: "unknown" } }],
    ["live-mode evidence", { evidence: { livemode: true } }],
    ["unreviewed source", { evidence: { evidenceSource: "browser_redirect" } }],
    ["wrong price lookup key", { evidence: { priceLookupKey: "gradia_core_20" } }],
    ["non-test account", { account: { providerMode: "live" } }],
  ] as const)("an 'active' pointer with %s is never eligible", (_name, patch) => {
    const result = evaluateBillingSnapshot(snap("active", patch as never))
    expect(result.eligibleToActivate).toBe(false)
    expect(result.state).toBe("reconciliation_required")
  })

  it("a legacy shops.plan value is not an input at all", () => {
    // The snapshot has no field for it; there is nothing to reinterpret.
    expect(Object.keys(snap("active").account ?? {})).not.toContain("plan")
  })
})

describe("billing DTO", () => {
  it("never carries a Checkout URL once the workspace is eligible", () => {
    const dto = billingDto({ state: "active", eligibleToActivate: true, blockingReason: null }, "https://checkout.stripe.com/c/pay/cs_test_x")
    expect(dto.checkoutUrl).toBeNull()
    expect(dto).toMatchObject({ providerMode: "test", planKey: "founder-pilot", catalogVersion: COMMERCIAL_CATALOG_VERSION })
  })
  it("carries the URL while checkout is needed", () => {
    const dto = billingDto({ state: "checkout_pending", eligibleToActivate: false, blockingReason: "checkout_required" }, "https://checkout.stripe.com/c/pay/cs_test_x")
    expect(dto.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_x")
  })
})

describe("server-owned return URLs", () => {
  it("accepts only allowlisted target keys", () => {
    expect(isReturnTarget("agents")).toBe(true)
    expect(isReturnTarget("billing")).toBe(true)
    for (const bad of ["https://evil.example/", "//evil.example", "/receptionist", "__proto__", "constructor", "", null, undefined, 3, {}]) {
      expect(isReturnTarget(bad)).toBe(false)
    }
  })

  it("builds same-origin URLs from configuration and a path the server owns", () => {
    const urls = buildCheckoutReturnUrls("https://app.gradia.example", "agents")
    expect(urls).toEqual({
      ok: true,
      successUrl: `https://app.gradia.example${CHECKOUT_RETURN_TARGETS.agents}?billing_return=success`,
      cancelUrl: `https://app.gradia.example${CHECKOUT_RETURN_TARGETS.agents}?billing_return=canceled`,
    })
  })

  it("never puts a session id or trusted flag in the success URL", () => {
    const urls = buildCheckoutReturnUrls("https://app.gradia.example", "billing")
    if (!urls.ok) throw new Error("expected urls")
    expect(urls.successUrl).not.toMatch(/session|cs_|CHECKOUT_SESSION_ID|paid|active/i)
  })

  it("drops any path or query in the configured origin", () => {
    const urls = buildCheckoutReturnUrls("https://app.gradia.example/evil?x=1#y", "agents")
    expect(urls).toMatchObject({ ok: true, successUrl: "https://app.gradia.example/receptionist?billing_return=success" })
  })

  it.each([undefined, null, "", "not a url", "ftp://app.gradia.example", "http://app.gradia.example", "https://user:pw@app.gradia.example"])(
    "refuses an unusable origin: %s",
    (origin) => {
      expect(buildCheckoutReturnUrls(origin as string, "agents")).toEqual({ ok: false, reason: "return_origin_unconfigured" })
    }
  )

  it("allows plain http only on loopback", () => {
    expect(buildCheckoutReturnUrls("http://localhost:3000", "agents").ok).toBe(true)
    expect(buildCheckoutReturnUrls("http://127.0.0.1:3000", "agents").ok).toBe(true)
  })
})

describe("checkout request fingerprint", () => {
  const base = {
    shopId: "00000000-0000-4000-8000-000000000001",
    catalogVersion: COMMERCIAL_CATALOG_VERSION,
    planKey: COMMERCIAL_PLAN_KEY,
    lookupKey: FOUNDER_PILOT_PRICE.lookupKey,
    returnTarget: "agents" as const,
  }
  it("is stable for an exact replay and changes for any changed field", () => {
    const fp = checkoutRequestFingerprint(base)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    expect(checkoutRequestFingerprint({ ...base })).toBe(fp)
    for (const changed of [
      { shopId: "00000000-0000-4000-8000-000000000002" },
      { catalogVersion: "2026-12-01.v1" },
      { planKey: "growth" },
      { lookupKey: "other" },
      { returnTarget: "billing" as const },
    ]) {
      expect(checkoutRequestFingerprint({ ...base, ...changed })).not.toBe(fp)
    }
  })
})
