import { describe, expect, it } from "vitest"

import { EVIDENCE_MAX_AGE_DAYS, evaluateAcceptanceEvidence } from "@/lib/commercial-acceptance-evidence"
import { runLocalFixtureChecks } from "@/lib/commercial-readiness-fixtures"
import { buildSandboxReport, formatSandboxReport } from "@/lib/commercial-sandbox-report"
import { REVIEWED_SETTLEMENT_METER_MAPPING, type MeterMapping } from "@/lib/commercial-settlement"
import { evaluateSandboxReadiness } from "@/lib/stripe-sandbox-contract"
import { collectSandboxSnapshot } from "@/lib/stripe-sandbox-verifier"
import { TEST_CLOCK_OPT_IN_ENV, runTestClockAcceptance, type AcceptanceEvidence } from "@/lib/stripe-test-clock-acceptance"
import { FakeStripeSandbox } from "./_fake-stripe-sandbox"
import { FakeTestClockStripe } from "./_fake-stripe-test-clock"

const SECRET_KEY = "sk_test_FAKEFAKEFAKEFAKE0123"
const GOOD = {
  GRADIA_COMMERCIAL_BILLING_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: SECRET_KEY,
  GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET: "whsec_" + "a1".repeat(16),
  GRADIA_DASHBOARD_URL: "https://app.gradia.example",
  CRON_SECRET: "unit-cron-secret",
  GRADIA_COMMERCIAL_BILLING_WORKER: "enabled",
}
const ATTEST = ["hosted_checkout_completion", "stripe_delivered_webhook"]
const config = { secretKey: SECRET_KEY, apiBase: "https://api.stripe.com/v1", timeoutMs: 5_000 }
const REAL_NOW = 1_800_000_000

async function checked(fake: FakeStripeSandbox) {
  const snap = await collectSandboxSnapshot(config, fake.request)
  if ("failure" in snap) throw new Error("unreachable")
  return { status: "checked" as const, ...evaluateSandboxReadiness(snap) }
}
async function realEvidence(): Promise<AcceptanceEvidence> {
  const fake = FakeTestClockStripe.clockSandbox(REAL_NOW)
  return runTestClockAcceptance(
    { ...GOOD, [TEST_CLOCK_OPT_IN_ENV]: "1" }, true,
    { request: fake.request, sleep: async () => undefined, nowSeconds: () => REAL_NOW }
  )
}
const codes = (r: { blockers: { code: string }[] }) => r.blockers.map((b) => b.code)
const NOW_MS = REAL_NOW * 1000 + 3_600_000

describe("sandbox acceptance report", () => {
  it("offline: NOT_READY, local fixtures PASS, and REAL Stripe acceptance is labelled NOT RUN", () => {
    const r = buildSandboxReport({ env: {}, verification: "skipped" })
    expect(r.status).toBe("NOT_READY")
    expect(r.localFixture.status).toBe("PASS")
    expect(r.localFixture.checks.every((c) => c.ok)).toBe(true)
    expect(r.realStripeAcceptance.status).toBe("NOT RUN")
    expect(codes(r)).toEqual([
      "stripe_unconfigured", "webhook_unconfigured", "cron_secret_missing", "worker_disabled", "stripe_sandbox_not_verified", "real_stripe_acceptance_not_run",
    ])
    const text = formatSandboxReport(r)
    expect(text).toContain("LOCAL FIXTURE READINESS: PASS")
    expect(text).toContain("REAL STRIPE ACCEPTANCE: NOT RUN")
    expect(text).toContain("SANDBOX ACCEPTANCE: NOT_READY")
    expect(r.manualSteps.length).toBeGreaterThan(8)
    expect(r.contract.productionPromotion).toBe("requires_final_reviewed_release_decision")
  })

  it("is READY only when the contract, exact items, webhook rule, worker, sandbox AND real evidence + attestation all hold", async () => {
    const verification = await checked(FakeStripeSandbox.provisioned(1))
    const evidence = await realEvidence()
    expect(evidence.overall).toBe("PASSED")
    const ready = buildSandboxReport({ env: GOOD, verification, evidence, attested: ATTEST, nowMs: NOW_MS })
    expect(codes(ready)).toEqual([])
    expect(ready.status).toBe("READY")
    expect(ready.realStripeAcceptance).toEqual({ status: "PASSED", attestedManualSteps: ATTEST })
    // Remove any one requirement and READY is impossible, with that exact reason.
    const without = (patch: Partial<Parameters<typeof buildSandboxReport>[0]>) => buildSandboxReport({ env: GOOD, verification, evidence, attested: ATTEST, nowMs: NOW_MS, ...patch })
    expect(codes(without({ evidence: null }))).toEqual(["real_stripe_acceptance_not_run"])
    expect(codes(without({ attested: [] }))).toEqual(["manual_step_unattested_hosted_checkout_completion", "manual_step_unattested_stripe_delivered_webhook"])
    expect(codes(without({ attested: ["hosted_checkout_completion"] }))).toEqual(["manual_step_unattested_stripe_delivered_webhook"])
    expect(codes(without({ verification: "skipped" }))).toEqual(["stripe_sandbox_not_verified"])
    expect(codes(without({ env: { ...GOOD, CRON_SECRET: "" } }))).toEqual(["cron_secret_missing"])
    expect(codes(without({ env: { ...GOOD, GRADIA_COMMERCIAL_BILLING_WORKER: "" } }))).toEqual(["worker_disabled"])
    expect(codes(without({ env: { ...GOOD, GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET: "" } }))).toEqual(["webhook_unconfigured"])
    expect(codes(without({ env: { ...GOOD, STRIPE_SECRET_KEY: "sk_live_FAKEFAKEFAKEFAKE0123" } }))).toContain("stripe_misconfigured")
    for (const patch of [{ verification: "skipped" as const }, { env: {} }]) expect(without(patch).status).toBe("NOT_READY")
  })

  it("an offline run can NEVER be READY, even with evidence and attestation supplied", async () => {
    const evidence = await realEvidence()
    const r = buildSandboxReport({ env: GOOD, verification: "skipped", evidence, attested: ATTEST, nowMs: NOW_MS })
    expect(r.status).toBe("NOT_READY")
    expect(codes(r)).toEqual(["stripe_sandbox_not_verified"])
  })

  it("turns each sandbox finding into a blocker and refuses a live-shaped key", async () => {
    const fake = FakeStripeSandbox.provisioned(1)
    fake.meters = fake.meters.slice(1)
    const r = buildSandboxReport({ env: GOOD, verification: await checked(fake), evidence: await realEvidence(), attested: ATTEST, nowMs: NOW_MS })
    expect(r.status).toBe("NOT_READY")
    expect(codes(r)).toContain("sandbox_meter_missing")
  })

  it("the committed mapping must be the exact contract: unprovisioned or drifted mappings block", async () => {
    const verification = await checked(FakeStripeSandbox.provisioned(1))
    const unprovisioned: MeterMapping = { ...REVIEWED_SETTLEMENT_METER_MAPPING, status: "unprovisioned" }
    const drifted: MeterMapping = { ...REVIEWED_SETTLEMENT_METER_MAPPING, entries: REVIEWED_SETTLEMENT_METER_MAPPING.entries.map((e, i) => (i === 2 ? { ...e, eventName: "renamed_event" } : e)) }
    const a = buildSandboxReport({ env: GOOD, verification, mapping: unprovisioned })
    expect(codes(a)).toContain("settlement_mapping_unprovisioned")
    expect(a.localFixture.status).toBe("FAIL")
    const b = buildSandboxReport({ env: GOOD, verification, mapping: drifted })
    expect(codes(b)).toEqual(expect.arrayContaining(["settlement_mapping_not_contract", "worker_misconfigured", "local_fixture_settlement_mapping_equals_contract_failed"]))
  })

  it("never prints a secret, key, object id or URL, and never claims a manual step was done", async () => {
    const verification = await checked(FakeStripeSandbox.provisioned(1))
    const text = formatSandboxReport(buildSandboxReport({ env: GOOD, verification, evidence: await realEvidence(), attested: [], nowMs: NOW_MS }))
    for (const value of [SECRET_KEY, GOOD.GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET, GOOD.CRON_SECRET, "https://app.gradia.example", "prod_", "mtr_", "cus_"]) expect(text).not.toContain(value)
    expect(text).toContain("NOT performed or verified by this command")
    expect(text).not.toMatch(/\b(done|completed|already created)\b/i)
  })
})

describe("real evidence judgement (strict, never a cryptographic proof)", () => {
  it("accepts a passed run with attested manual steps and refuses everything else", async () => {
    const evidence = await realEvidence()
    const judge = (raw: unknown, over: { nowMs?: number; attested?: string[] } = {}) => evaluateAcceptanceEvidence(raw, { nowMs: NOW_MS, attested: ATTEST, ...over })
    expect(judge(evidence)).toMatchObject({ status: "PASSED", findings: [] })
    expect(judge(null).status).toBe("NOT RUN")
    expect(judge(undefined).status).toBe("NOT RUN")
    expect(judge("not json object").status).toBe("INVALID")
    expect(judge({ ...evidence, extra: 1 }).status).toBe("INVALID") // strict: no smuggled fields
    expect(judge({ ...evidence, mode: "live" }).status).toBe("INVALID")
    expect(judge({ ...evidence, steps: [...evidence.steps, { id: "cus_leakedleaked1", status: "PASS", code: null }] }).status).toBe("INVALID")
    expect(judge({ ...evidence, limitations: ["see https://dashboard.stripe.com/test/x"] }).findings).toEqual(["real_evidence_forbidden_content"])
    expect(judge({ ...evidence, limitations: ["key sk_test_abcdefghij"] }).status).toBe("INVALID")
    // The contract moved on since the run.
    for (const patch of [{ itemSetDigest: "0".repeat(64) }, { contractVersion: "sandbox-contract.v1" }, { meterApiVersion: "2024-06-20" }, { mappingVersion: "settlement-mapping.v1-unprovisioned" }]) {
      expect(judge({ ...evidence, ...patch }).status).toBe("CONTRACT CHANGED")
    }
    // Freshness.
    expect(judge(evidence, { nowMs: REAL_NOW * 1000 + (EVIDENCE_MAX_AGE_DAYS + 1) * 86_400_000 }).status).toBe("STALE")
    expect(judge({ ...evidence, completedAt: new Date(NOW_MS + 86_400_000).toISOString() }).status).toBe("STALE")
    expect(judge({ ...evidence, completedAt: "garbage" }).status).toBe("STALE")
  })

  it("a failed, incomplete or unclean run is never READY-grade, and manual steps need attestation", async () => {
    const evidence = await realEvidence()
    const mutate = (fn: (e: AcceptanceEvidence) => void) => {
      const copy = JSON.parse(JSON.stringify(evidence)) as AcceptanceEvidence
      fn(copy)
      return evaluateAcceptanceEvidence(copy, { nowMs: NOW_MS, attested: ATTEST })
    }
    const failed = mutate((e) => { e.overall = "FAILED"; e.steps.find((s) => s.id === "renewal_invoice_with_usage")!.status = "FAIL" })
    expect(failed.status).toBe("FAILED")
    expect(failed.findings).toEqual(expect.arrayContaining(["real_evidence_step_renewal_invoice_with_usage", "real_evidence_not_passed"]))
    const incomplete = mutate((e) => { e.overall = "INCOMPLETE"; e.steps.find((s) => s.id === "invoice_preview")!.status = "NOT_RUN" })
    expect(incomplete.status).toBe("INCOMPLETE")
    expect(mutate((e) => { e.steps = e.steps.filter((s) => s.id !== "cancellation") }).findings).toContain("real_evidence_step_cancellation")
    expect(mutate((e) => { e.steps.push({ ...e.steps[0] }) }).findings).toContain("real_evidence_step_sandbox_contract") // duplicate step id
    expect(mutate((e) => { e.cleanup = "failed" }).findings).toContain("real_evidence_cleanup_failed")
    // A file can never carry a manual step as passed: attestation is the operator's explicit, separate claim.
    expect(mutate((e) => { e.steps.find((s) => s.id === "hosted_checkout_completion")!.status = "PASS" }).status).toBe("PASSED")
    expect(evaluateAcceptanceEvidence(evidence, { nowMs: NOW_MS, attested: [] }).findings).toEqual([
      "manual_step_unattested_hosted_checkout_completion", "manual_step_unattested_stripe_delivered_webhook",
    ])
    expect(evaluateAcceptanceEvidence(evidence, { nowMs: NOW_MS, attested: ["anything_else", "hosted_checkout_completion"] }).attested).toEqual(["hosted_checkout_completion"])
  })
})

describe("local fixture checks", () => {
  it("pass for the committed contract and fail for a drifted mapping", () => {
    expect(runLocalFixtureChecks().every((c) => c.ok)).toBe(true)
    const drifted: MeterMapping = { ...REVIEWED_SETTLEMENT_METER_MAPPING, entries: REVIEWED_SETTLEMENT_METER_MAPPING.entries.map((e, i) => (i === 0 ? { ...e, eventName: "x_renamed" } : e)) }
    expect(runLocalFixtureChecks(drifted).filter((c) => !c.ok).map((c) => c.id)).toEqual(["settlement_mapping_equals_contract", "worker_fails_closed"])
  })
})
