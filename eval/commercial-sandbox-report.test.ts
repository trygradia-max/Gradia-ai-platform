import { describe, expect, it } from "vitest"

import { buildSandboxReport, formatSandboxReport } from "@/lib/commercial-sandbox-report"
import { evaluateSandboxReadiness } from "@/lib/stripe-sandbox-contract"
import { collectSandboxSnapshot } from "@/lib/stripe-sandbox-verifier"
import { FakeStripeSandbox } from "./_fake-stripe-sandbox"

const SECRET_KEY = "sk_test_FAKEFAKEFAKEFAKE0123"
const GOOD = {
  GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: SECRET_KEY,
  GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET: "whsec_" + "a1".repeat(16),
  GRADIA_DASHBOARD_URL: "https://app.gradia.example",
}
const config = { secretKey: SECRET_KEY, apiBase: "https://api.stripe.com/v1", timeoutMs: 5_000 }
async function checked(fake: FakeStripeSandbox) {
  const snap = await collectSandboxSnapshot(config, fake.request)
  if ("failure" in snap) throw new Error("unreachable")
  return { status: "checked" as const, ...evaluateSandboxReadiness(snap) }
}

describe("sandbox acceptance report", () => {
  it("is NOT_READY by default, with a finite ordered blocker list and the manual steps", () => {
    const r = buildSandboxReport({ env: {}, verification: "skipped" })
    expect(r.status).toBe("NOT_READY")
    expect(r.blockers.map((b) => b.code)).toEqual(["stripe_unconfigured", "webhook_unconfigured", "stripe_sandbox_not_verified", "settlement_mapping_unprovisioned"])
    expect(r.manualSteps.length).toBeGreaterThan(5)
    expect(r.notVerifiedHere.join(" ")).toMatch(/PR F2/)
  })
  it("is READY only when configuration, a verified sandbox and a provisioned mapping all hold", async () => {
    const verification = await checked(FakeStripeSandbox.provisioned(1))
    expect(buildSandboxReport({ env: GOOD, verification, mappingStatus: "provisioned" }).status).toBe("READY")
    // Everything verified but the mapping: exactly one blocker, and the reviewed-commit instruction.
    expect(buildSandboxReport({ env: GOOD, verification }).blockers.map((b) => b.code)).toEqual(["settlement_mapping_unprovisioned"])
  })
  it("turns each sandbox finding into a blocker and refuses a live-shaped key", async () => {
    const fake = FakeStripeSandbox.provisioned(1)
    fake.meters = fake.meters.slice(1)
    const r = buildSandboxReport({ env: GOOD, verification: await checked(fake), mappingStatus: "provisioned" })
    expect(r.status).toBe("NOT_READY")
    expect(r.blockers.map((b) => b.code)).toContain("sandbox_meter_missing")
    expect(buildSandboxReport({ env: { ...GOOD, STRIPE_SECRET_KEY: "sk_live_FAKEFAKEFAKEFAKE0123" }, verification: "skipped" }).blockers.map((b) => b.code)).toContain("stripe_misconfigured")
  })
  it("never prints a secret, key, object id or URL, and never claims a manual step was done", async () => {
    const verification = await checked(FakeStripeSandbox.provisioned(1))
    const text = formatSandboxReport(buildSandboxReport({ env: GOOD, verification }))
    for (const value of [SECRET_KEY, GOOD.GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET, "https://app.gradia.example", "prod_", "mtr_", "cus_"]) expect(text).not.toContain(value)
    expect(text).toContain("NOT performed or verified by this command")
    expect(text).not.toMatch(/\b(done|completed|already created)\b/i)
  })
})
