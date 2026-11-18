import { WORKER_ENABLE_FLAG, resolveCommercialWorkerConfig } from "@/lib/commercial-billing-worker"
import { evaluateAcceptanceEvidence, type EvidenceFindingCode, type RealAcceptanceStatus } from "@/lib/commercial-acceptance-evidence"
import { runLocalFixtureChecks, type LocalCheck } from "@/lib/commercial-readiness-fixtures"
import { REVIEWED_SETTLEMENT_METER_MAPPING, type MeterMapping } from "@/lib/commercial-settlement"
import { resolveCommercialWebhookConfig } from "@/lib/commercial-webhook"
import { resolveCommercialStripeConfig } from "@/lib/stripe-commercial"
import {
  COMMERCIAL_METER_API_VERSION,
  SANDBOX_BASE_PRICE,
  SANDBOX_MANUAL_STEPS,
  SANDBOX_METERS,
  SANDBOX_CONTRACT_STATUS,
  SANDBOX_PRODUCTION_PROMOTION,
  mappingMatchesSandboxContract,
  type SandboxFindingCode,
} from "@/lib/stripe-sandbox-contract"
import type { SandboxVerification } from "@/lib/stripe-sandbox-verifier"

/**
 * The operator's sandbox acceptance report (Commercial Billing PR F / F2). Pure: it takes the already-gathered facts and
 * returns READY or a FINITE, ordered list of blockers. It never prints a secret, a key, a Stripe object id, a URL or a
 * payload; only fixed codes and fixed sentences. It never claims a manual Dashboard step was performed.
 *
 * READY is impossible unless ALL of these hold (each is a blocker otherwise):
 *   1. the F1 contract is internally consistent and the committed settlement mapping equals it exactly (local fixture);
 *   2. the production webhook rule accepts exactly the contract item set and refuses every mutation (local fixture);
 *   3. configuration is TEST-shaped (Stripe, webhook secret, dashboard origin) and the worker is enabled and configured;
 *   4. the Stripe TEST sandbox, read-only, matches the contract (`--network`);
 *   5. REAL Stripe test-clock evidence exists, is current, passed every automated step, and the manual steps are attested.
 * An offline run can prove (1)-(2) only and labels real Stripe acceptance `NOT RUN`.
 */

export type ReportBlockerCode =
  | "stripe_unconfigured"
  | "stripe_misconfigured"
  | "webhook_unconfigured"
  | "webhook_misconfigured"
  | "dashboard_url_missing"
  | "cron_secret_missing"
  | "worker_disabled"
  | "worker_misconfigured"
  | "stripe_sandbox_not_verified"
  | "stripe_sandbox_unreachable"
  | "settlement_mapping_unprovisioned"
  | "settlement_mapping_not_contract"
  | `local_fixture_${string}_failed`
  | `sandbox_${SandboxFindingCode}`
  | EvidenceFindingCode

export type ReportBlocker = { code: ReportBlockerCode; subject?: string; text: string }

export type SandboxReport = {
  status: "READY" | "NOT_READY"
  /** Offline checks only: the committed contract, mapping and webhook rule against fixtures. */
  localFixture: { status: "PASS" | "FAIL"; checks: LocalCheck[] }
  /** The real Stripe test-clock run. `NOT RUN` unless real evidence is supplied. */
  realStripeAcceptance: { status: RealAcceptanceStatus; attestedManualSteps: string[] }
  contract: { status: typeof SANDBOX_CONTRACT_STATUS; meterApiVersion: string; productionPromotion: typeof SANDBOX_PRODUCTION_PROMOTION }
  blockers: ReportBlocker[]
  /** What the verifier expects Dashboard to contain (names only; never ids). */
  expected: { baseLookupKey: string; meters: { component: string; eventName: string; meteredPriceLookupKey: string; unitAmountCents: number }[] }
  /** Steps only a human can do. Never reported as done. */
  manualSteps: readonly { id: string; text: string }[]
  /** What this command does NOT prove, always printed. */
  notVerifiedHere: string[]
}

const BLOCKER_TEXT: Record<string, string> = {
  stripe_unconfigured: "Set GRADIA_COMMERCIAL_BILLING_STRIPE_MODE=test and a sandbox STRIPE_SECRET_KEY (sk_test_ or rk_test_) in the environment of this command.",
  stripe_misconfigured: "The Stripe configuration is present but not a loopback/official TEST configuration (a live-shaped key is always refused).",
  webhook_unconfigured: "Set GRADIA_COMMERCIAL_STRIPE_WEBHOOK_SECRET (a test-mode whsec_ signing secret for the commercial endpoint).",
  webhook_misconfigured: "The commercial webhook secret is malformed or equals the Connect webhook secret.",
  dashboard_url_missing: "Set GRADIA_DASHBOARD_URL (https, or loopback) so Checkout/Portal return URLs can be built.",
  cron_secret_missing: "Set CRON_SECRET so the billing worker cron route can authenticate its caller.",
  worker_disabled: `The billing worker is disabled. Set ${WORKER_ENABLE_FLAG}=enabled (test configuration only) to enable it.`,
  worker_misconfigured: "The billing worker is enabled but its Stripe configuration is missing, live-shaped, or the settlement mapping is not the exact sandbox contract.",
  stripe_sandbox_not_verified: "The sandbox was not read. Re-run with --network (an explicit, read-only Stripe test-mode check).",
  stripe_sandbox_unreachable: "The Stripe sandbox could not be read (network, key or API version). Nothing was changed.",
  settlement_mapping_unprovisioned: "REVIEWED_SETTLEMENT_METER_MAPPING is unprovisioned.",
  settlement_mapping_not_contract: "REVIEWED_SETTLEMENT_METER_MAPPING is not exactly the sandbox contract (event names or value basis differ).",
  real_stripe_acceptance_not_run: "Real Stripe test-clock acceptance has NOT RUN. Run `npm run billing:test-clock-acceptance -- --i-understand-this-mutates-stripe-test --evidence-out <file>` (opt-in, mutates only the Stripe TEST sandbox), then pass --evidence <file>.",
  real_evidence_invalid: "The evidence file is not a valid test-clock evidence record.",
  real_evidence_forbidden_content: "The evidence file contains something id-, URL- or secret-shaped and is refused.",
  real_evidence_contract_changed: "The evidence was produced for a different contract (item set, API version or mapping). Re-run the acceptance.",
  real_evidence_stale: "The evidence is older than 30 days (or from the future). Re-run the acceptance.",
  real_evidence_not_passed: "The evidence run did not pass.",
  real_evidence_cleanup_failed: "The evidence run could not delete its test clock. Delete the simulation in the Stripe TEST Dashboard, then re-run.",
}
const manualText = (id: string) =>
  id === "hosted_checkout_completion"
    ? "No human attestation of a HOSTED Checkout (test card) for the exact item set. Run one in a browser, then pass --attest hosted_checkout_completion."
    : "A human has not attested a Stripe-DELIVERED, signed webhook reaching the commercial endpoint (Dashboard event deliveries). Confirm it, then pass --attest stripe_delivered_webhook."

export function buildSandboxReport(input: {
  env: Record<string, string | undefined>
  verification: SandboxVerification | "skipped"
  /** Parsed real test-clock evidence, or null/undefined when none was supplied. */
  evidence?: unknown
  /** Manual steps the operator attests at report time (never inferred). */
  attested?: readonly string[]
  nowMs?: number
  /** Test seam: defaults to the committed reviewed mapping. */
  mapping?: MeterMapping
}): SandboxReport {
  const mapping = input.mapping ?? REVIEWED_SETTLEMENT_METER_MAPPING
  const blockers: ReportBlocker[] = []
  const stripe = resolveCommercialStripeConfig(input.env)
  if (!stripe.ok) {
    const code = stripe.reason === "billing_unconfigured" ? "stripe_unconfigured" : "stripe_misconfigured"
    blockers.push({ code, text: BLOCKER_TEXT[code] })
  } else if (!stripe.returnOrigin) {
    blockers.push({ code: "dashboard_url_missing", text: BLOCKER_TEXT.dashboard_url_missing })
  }
  const webhook = resolveCommercialWebhookConfig(input.env)
  if (!webhook.ok) {
    const code = webhook.reason === "webhook_unconfigured" ? "webhook_unconfigured" : "webhook_misconfigured"
    blockers.push({ code, text: BLOCKER_TEXT[code] })
  }
  if (!input.env.CRON_SECRET?.trim()) blockers.push({ code: "cron_secret_missing", text: BLOCKER_TEXT.cron_secret_missing })
  const worker = resolveCommercialWorkerConfig(input.env, mapping)
  if (!worker.ok) {
    if (worker.status === "disabled") blockers.push({ code: "worker_disabled", text: BLOCKER_TEXT.worker_disabled })
    // A Stripe-config problem is already reported above; only the mapping drift is new information here.
    else if (worker.reason === "mapping_contract_mismatch") blockers.push({ code: "worker_misconfigured", text: BLOCKER_TEXT.worker_misconfigured })
  }

  if (input.verification === "skipped") {
    blockers.push({ code: "stripe_sandbox_not_verified", text: BLOCKER_TEXT.stripe_sandbox_not_verified })
  } else if (input.verification.status === "not_run") {
    // Configuration blockers above already explain a config refusal; do not repeat it.
    if (input.verification.reason === "provider_unreachable") {
      blockers.push({ code: "stripe_sandbox_unreachable", text: BLOCKER_TEXT.stripe_sandbox_unreachable })
    }
  } else {
    for (const finding of input.verification.findings) {
      blockers.push({
        code: `sandbox_${finding.code}`,
        subject: finding.subject,
        text: `Sandbox does not match the contract: ${finding.code.replace(/_/g, " ")} (${finding.subject}).`,
      })
    }
  }

  if (mapping.status !== "provisioned") blockers.push({ code: "settlement_mapping_unprovisioned", text: BLOCKER_TEXT.settlement_mapping_unprovisioned })
  else if (!mappingMatchesSandboxContract(mapping)) blockers.push({ code: "settlement_mapping_not_contract", text: BLOCKER_TEXT.settlement_mapping_not_contract })

  const checks = runLocalFixtureChecks(mapping)
  for (const check of checks) {
    if (!check.ok) blockers.push({ code: `local_fixture_${check.id}_failed`, text: `Local fixture check failed: ${check.id.replace(/_/g, " ")}.` })
  }

  const judgement = evaluateAcceptanceEvidence(input.evidence ?? null, { nowMs: input.nowMs, attested: input.attested })
  for (const finding of judgement.findings) {
    const text = finding.startsWith("manual_step_unattested_")
      ? manualText(finding.slice("manual_step_unattested_".length))
      : finding.startsWith("real_evidence_step_")
        ? `The evidence run did not pass the step ${finding.slice("real_evidence_step_".length).replace(/_/g, " ")}.`
        : BLOCKER_TEXT[finding]
    blockers.push({ code: finding, text })
  }

  return {
    status: blockers.length === 0 ? "READY" : "NOT_READY",
    localFixture: { status: checks.every((c) => c.ok) ? "PASS" : "FAIL", checks },
    realStripeAcceptance: { status: judgement.status, attestedManualSteps: judgement.attested },
    contract: { status: SANDBOX_CONTRACT_STATUS, meterApiVersion: COMMERCIAL_METER_API_VERSION, productionPromotion: SANDBOX_PRODUCTION_PROMOTION },
    blockers,
    expected: {
      baseLookupKey: SANDBOX_BASE_PRICE.lookupKey,
      meters: SANDBOX_METERS.map((m) => ({
        component: m.component, eventName: m.eventName, meteredPriceLookupKey: m.meteredPriceLookupKey, unitAmountCents: m.meteredUnitAmountCents,
      })),
    },
    manualSteps: SANDBOX_MANUAL_STEPS,
    notVerifiedHere: [
      "Anything in live mode. This command refuses live configuration and never touches production. Production promotion requires a final reviewed release decision.",
      "That a Stripe Dashboard webhook endpoint exists and is pinned to the reviewed API version (a Dashboard step; not read by this command).",
      "Customer Portal configuration (founder decision).",
      "Settlement creation is not scheduled: the worker sweeps delivery, reconciliation and approved adjustments only (a system-actor policy is a founder decision).",
      "Open founder policy that stays fail-closed: seat partial-day proration, grace/dunning timing, tax, refund/credit eligibility, resubscription, reviewer role/UI, voice/SMS runtime gating, unknown-delivery resend.",
    ],
  }
}

export function formatSandboxReport(report: SandboxReport): string {
  const lines: string[] = []
  lines.push(`SANDBOX ACCEPTANCE: ${report.status}`)
  lines.push(`Contract status: ${report.contract.status} (meter API version ${report.contract.meterApiVersion}); production promotion: ${report.contract.productionPromotion}`)
  lines.push(`LOCAL FIXTURE READINESS: ${report.localFixture.status} (${report.localFixture.checks.filter((c) => c.ok).length}/${report.localFixture.checks.length} offline checks)`)
  lines.push(`REAL STRIPE ACCEPTANCE: ${report.realStripeAcceptance.status}${report.realStripeAcceptance.status === "NOT RUN" ? " (offline fixtures are not a real Stripe run)" : ""}`)
  if (report.blockers.length > 0) {
    lines.push("", `Blockers (${report.blockers.length}):`)
    report.blockers.forEach((b, i) => lines.push(`  ${i + 1}. [${b.code}] ${b.text}`))
  }
  lines.push("", "Expected in the Stripe TEST-mode sandbox (names only):")
  lines.push(`  base price lookup key: ${report.expected.baseLookupKey}`)
  for (const m of report.expected.meters) {
    lines.push(`  meter event ${m.eventName} | price lookup key ${m.meteredPriceLookupKey} | ${m.unitAmountCents} cent(s) per unit`)
  }
  lines.push("", "Manual Stripe Dashboard steps (NOT performed or verified by this command):")
  report.manualSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.text}`))
  lines.push("", "Not verified by this command:")
  report.notVerifiedHere.forEach((t) => lines.push(`  - ${t}`))
  return lines.join("\n")
}
