import { describe, expect, it } from "vitest"

import {
  ACCEPTANCE_METERED_CENTS,
  AUTOMATED_STEPS,
  HarnessAbort,
  MANUAL_STEPS,
  TEST_CLOCK_CONFIRM_FLAG,
  TEST_CLOCK_OPT_IN_ENV,
  createFencedRequest,
  evaluateHarnessGuard,
  formatEvidence,
  runTestClockAcceptance,
  type AcceptanceEvidence,
} from "@/lib/stripe-test-clock-acceptance"
import { stripeCommercialRequest } from "@/lib/stripe"
import { FakeTestClockStripe, type TestClockFakeOptions } from "./_fake-stripe-test-clock"

const KEY = "sk_test_FAKEFAKEFAKEFAKE0123"
const ENV = { [TEST_CLOCK_OPT_IN_ENV]: "1", GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test", STRIPE_SECRET_KEY: KEY }
const REAL_NOW = 1_800_000_000
const sleep = async () => undefined

async function run(options: TestClockFakeOptions = {}, env: Record<string, string | undefined> = ENV, confirmed = true) {
  const fake = FakeTestClockStripe.clockSandbox(REAL_NOW, options)
  const lines: string[] = []
  const evidence = await runTestClockAcceptance(env, confirmed, { request: fake.request, sleep, nowSeconds: () => REAL_NOW, log: (l) => lines.push(l) })
  return { fake, evidence, lines }
}
const status = (e: AcceptanceEvidence, id: string) => e.steps.find((s) => s.id === id)

// Nothing an operator reads may carry an id, URL, key or payload.
const SECRETISH = /\b(cus|sub|in|cs_test|clock|price|prod|mtr|mtrusg|pm|evt|si|bps|ii)_(?!and_customer)[A-Za-z0-9]{3,}|whsec_|(sk|rk)_(test|live)_|https?:\/\//

describe("harness guard (refuses before any request)", () => {
  it.each([
    ["not opted in (env)", { ...ENV, [TEST_CLOCK_OPT_IN_ENV]: "" }, true, "not_opted_in"],
    ["opt-in env set to something else", { ...ENV, [TEST_CLOCK_OPT_IN_ENV]: "true" }, true, "not_opted_in"],
    ["no confirmation flag", ENV, false, "not_confirmed"],
    ["CI", { ...ENV, CI: "true" }, true, "ci_refused"],
    ["GitHub Actions", { ...ENV, GITHUB_ACTIONS: "true" }, true, "ci_refused"],
    ["a live key", { ...ENV, STRIPE_SECRET_KEY: "sk_live_FAKEFAKEFAKEFAKE0123" }, true, "billing_misconfigured"],
    ["a live restricted key", { ...ENV, STRIPE_SECRET_KEY: "rk_live_FAKEFAKEFAKEFAKE0123" }, true, "billing_misconfigured"],
    ["a non-test mode flag", { ...ENV, GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "live" }, true, "billing_misconfigured"],
    ["a foreign API base", { ...ENV, STRIPE_API_BASE: "https://evil.example/v1" }, true, "billing_misconfigured"],
    ["no key", { ...ENV, STRIPE_SECRET_KEY: undefined }, true, "billing_unconfigured"],
  ])("refuses %s", async (_name, env, confirmed, code) => {
    expect(evaluateHarnessGuard(env, confirmed)).toEqual({ ok: false, code })
    const { fake, evidence } = await run({}, env, confirmed)
    expect(evidence.overall).toBe("REFUSED")
    expect(fake.requests).toHaveLength(0) // not a single request was sent
    expect(fake.clocks.size).toBe(0)
    expect(evidence.steps.every((s) => s.status === "NOT_RUN" || s.status === "MANUAL")).toBe(true)
  })

  it("CI=false / 0 is not CI; the confirmation flag has the documented spelling", () => {
    expect(evaluateHarnessGuard({ ...ENV, CI: "false" }, true).ok).toBe(true)
    expect(evaluateHarnessGuard({ ...ENV, CI: "0" }, true).ok).toBe(true)
    expect(TEST_CLOCK_CONFIRM_FLAG).toBe("--i-understand-this-mutates-stripe-test")
  })
})

describe("the full run (faithful local stand-in; assumptions are in the fake's header)", () => {
  it("passes every automated step, leaves the manual steps MANUAL, and deletes everything it created", async () => {
    const { fake, evidence } = await run()
    expect(evidence.overall).toBe("PASSED")
    expect(evidence.steps.filter((s) => (AUTOMATED_STEPS as readonly string[]).includes(s.id)).map((s) => [s.id, s.status])).toEqual(
      AUTOMATED_STEPS.map((id) => [id, id === "late_usage_after_finalization" ? "OBSERVED" : "PASS"])
    )
    expect(MANUAL_STEPS.map((id) => status(evidence, id)?.status)).toEqual(["MANUAL", "MANUAL"])
    expect(evidence.cleanup).toBe("deleted")
    expect([...fake.clocks.values()].every((c) => c.deleted)).toBe(true)
    expect([...fake.customers.values()].every((c) => c.deleted)).toBe(true)
    expect([...fake.sessions.values()].every((s) => s.status === "expired")).toBe(true)
    // The renewal billed exactly base + the usage we sent (usage reached Stripe before finalization).
    expect(status(evidence, "renewal_invoice_with_usage")?.numbers).toMatchObject({ totalCents: 19_900 + ACCEPTANCE_METERED_CENTS, meteredCents: ACCEPTANCE_METERED_CENTS })
    expect(status(evidence, "late_usage_after_finalization")?.code).toBe("late_usage_not_billed")
    expect(evidence.limitations.join(" ")).toMatch(/Hosted Checkout cannot be completed by API/)
  })

  it("the Checkout session carried the exact items (base x1, six metered without a quantity)", async () => {
    const { fake } = await run()
    const session = [...fake.sessions.values()][0]
    expect(session.items).toHaveLength(7)
    expect(session.items[0].quantity).toBe(1)
    expect(session.items.slice(1).every((i) => i.quantity === undefined)).toBe(true)
  })

  it("starts the clock ~25 days back so period 1 spans real 'now', and meter events carry in-period timestamps", async () => {
    const { fake } = await run()
    const clock = [...fake.clocks.values()][0]
    expect(clock.frozen).toBeGreaterThan(REAL_NOW) // advanced
    for (const ev of fake.events.values()) {
      expect(ev.timestamp).toBeLessThanOrEqual(REAL_NOW)
      expect(ev.timestamp).toBeGreaterThan(REAL_NOW - 35 * 86_400)
    }
    expect(fake.duplicateMeterEventAttempts).toBe(0)
  })

  it("only touches allowlisted routes, only deletes clocks and subscriptions, never refunds, credits or cancels anything else", async () => {
    const { fake } = await run()
    const mutating = fake.requests.filter((r) => r.method !== "GET")
    expect(mutating.length).toBeGreaterThan(10)
    for (const r of fake.requests) {
      expect(r.path).not.toMatch(/refund|credit_note|charges|payouts|accounts|transfers|webhook_endpoints|products/)
      if (r.path === "/prices") expect(r.method).toBe("GET") // prices are only ever READ
    }
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path.split("/")[1])).toEqual(["subscriptions", "test_helpers"])
    // Creates carry an idempotency key where the harness controls it.
    for (const path of ["/checkout/sessions", "/subscriptions", "/billing/meter_events"]) {
      expect(fake.requests.filter((r) => r.path === path && r.method === "POST").every((r) => r.idempotencyKey)).toBe(true)
    }
  })

  it("prints and stores no id, URL, key, payload or personal datum", async () => {
    const { evidence, lines } = await run()
    for (const text of [JSON.stringify(evidence), formatEvidence(evidence), lines.join("\n")]) {
      expect(text.match(SECRETISH)?.[0]).toBeUndefined()
      expect(text).not.toContain(KEY)
    }
  })
})

describe("failure handling is truthful and always cleans up", () => {
  it("a rejected subscription FAILS that step, marks the rest NOT_RUN, never fakes success, and still deletes the clock", async () => {
    const { fake, evidence } = await run({ rejectSubscription: true })
    expect(evidence.overall).toBe("FAILED")
    expect(status(evidence, "subscription_exact_items")).toMatchObject({ status: "FAIL", code: "provider_400_invalid_request" })
    for (const id of ["webhook_normalization_exact_items", "first_period", "renewal_invoice_with_usage", "recovery", "cancellation"]) {
      expect(status(evidence, id)).toMatchObject({ status: "NOT_RUN", code: "earlier_step_failed" })
    }
    expect(evidence.cleanup).toBe("deleted")
    expect([...fake.clocks.values()].every((c) => c.deleted)).toBe(true)
  })

  it("a sandbox that does not match the contract stops before creating ANYTHING", async () => {
    const fake = FakeTestClockStripe.clockSandbox(REAL_NOW)
    delete fake.prices["gradia_fp_2026_11_sms_segment_metered"]
    const evidence = await runTestClockAcceptance(ENV, true, { request: fake.request, sleep, nowSeconds: () => REAL_NOW })
    expect(evidence.overall).toBe("FAILED")
    expect(status(evidence, "sandbox_contract")).toMatchObject({ status: "FAIL", code: "sandbox_price_missing" })
    expect(fake.clocks.size).toBe(0)
    expect(evidence.cleanup).toBe("not_needed")
    expect(fake.requests.every((r) => r.method === "GET")).toBe(true)
  })

  it("a live-mode object aborts the run (and the clock is still deleted)", async () => {
    const { fake, evidence } = await run({ liveCustomer: true })
    expect(evidence.overall).toBe("FAILED")
    expect(status(evidence, "clock_and_customer")).toMatchObject({ status: "FAIL", code: "live_object_refused" })
    expect(evidence.cleanup).toBe("deleted")
    expect([...fake.clocks.values()].every((c) => c.deleted)).toBe(true)
  })

  it("an unavailable preview endpoint is an honest NOT_RUN: the run is INCOMPLETE, never PASSED", async () => {
    const { evidence } = await run({ previewUnsupported: true })
    expect(status(evidence, "invoice_preview")).toMatchObject({ status: "NOT_RUN", code: "preview_api_unavailable" })
    expect(evidence.overall).toBe("INCOMPLETE")
  })

  it("a cleanup failure is reported (FAILED) with the manual instruction, never hidden", async () => {
    const { evidence, lines } = await run({ deleteClockFails: true })
    expect(evidence.cleanup).toBe("failed")
    expect(evidence.overall).toBe("FAILED")
    expect(lines.join("\n")).toMatch(/CLEANUP_FAILED/)
  })
})

describe("the fence", () => {
  const owned = new Set<string>(["clock_Mine0001", "sub_Mine0001"])
  const config = { secretKey: KEY, apiBase: "https://api.stripe.com/v1", timeoutMs: 1000 }
  const ok = (async () => ({ object: "x", livemode: false })) as unknown as typeof stripeCommercialRequest
  const call = (req: typeof stripeCommercialRequest, method: "GET" | "POST" | "DELETE", path: string) => req(config, { method, path })

  it("refuses any route outside the allowlist", async () => {
    const fenced = createFencedRequest(ok, owned)
    for (const [m, p] of [
      ["POST", "/refunds"], ["POST", "/credit_notes"], ["POST", "/charges"], ["GET", "/accounts"], ["POST", "/payouts"],
      ["DELETE", "/customers/cus_Other0001"], ["POST", "/products"], ["POST", "/prices"], ["POST", "/webhook_endpoints"],
      ["DELETE", "/prices/price_x0001"], ["POST", "/subscriptions/sub_Mine0001/cancel"],
    ] as const) {
      await expect(call(fenced, m, p), `${m} ${p}`).rejects.toMatchObject({ code: "request_not_allowlisted" })
    }
  })
  it("refuses to mutate an object this run did not create", async () => {
    const fenced = createFencedRequest(ok, owned)
    await expect(call(fenced, "DELETE", "/test_helpers/test_clocks/clock_Foreign01")).rejects.toMatchObject({ code: "object_not_created_by_this_run" })
    await expect(call(fenced, "DELETE", "/subscriptions/sub_Foreign01")).rejects.toMatchObject({ code: "object_not_created_by_this_run" })
    await expect(call(fenced, "POST", "/test_helpers/test_clocks/clock_Foreign01/advance")).rejects.toMatchObject({ code: "object_not_created_by_this_run" })
    await expect(call(fenced, "DELETE", "/test_helpers/test_clocks/clock_Mine0001")).resolves.toBeDefined()
  })
  it("aborts on any live-shaped response", async () => {
    for (const payload of [{ livemode: true }, { id: "cs_live_abcdefgh" }, { key: "sk_live_abcdefgh" }, { nested: { livemode: true } }]) {
      const fenced = createFencedRequest((async () => payload) as unknown as typeof stripeCommercialRequest, owned)
      await expect(call(fenced, "GET", "/prices")).rejects.toBeInstanceOf(HarnessAbort)
      await expect(call(fenced, "GET", "/prices")).rejects.toMatchObject({ code: "live_object_refused" })
    }
  })
})

describe("never part of normal CI", () => {
  it("is not reachable from the unit or integration globs", async () => {
    const { readFileSync } = await import("node:fs")
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }
    expect(pkg.scripts.test).toContain("--exclude '**/integration/**'")
    expect(pkg.scripts["billing:test-clock-acceptance"]).toContain("scripts/stripe-test-clock-acceptance.mjs")
    // The script file lives outside eval/ and src/, so no vitest glob picks it up.
    expect(pkg.scripts.test).not.toContain("test-clock")
    expect(pkg.scripts["test:int"]).not.toContain("test-clock")
  })
})
