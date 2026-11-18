import { REVIEWED_SETTLEMENT_METER_MAPPING } from "@/lib/commercial-settlement"
import { resolveCommercialWebhookConfig } from "@/lib/commercial-webhook"
import { resolveCommercialStripeConfig } from "@/lib/stripe-commercial"
import {
  COMMERCIAL_METER_API_VERSION,
  SANDBOX_BASE_PRICE,
  SANDBOX_MANUAL_STEPS,
  SANDBOX_METERS,
  SANDBOX_CONTRACT_STATUS,
  type SandboxFindingCode,
} from "@/lib/stripe-sandbox-contract"
import type { SandboxVerification } from "@/lib/stripe-sandbox-verifier"

/**
 * The operator's sandbox acceptance report (Commercial Billing PR F). Pure: it takes the
 * already-gathered facts and returns READY or a FINITE, ordered list of blockers. It never
 * prints a secret, a key, a Stripe object id, a URL or a payload; only fixed codes and fixed
 * sentences. It never claims a manual Dashboard step was performed.
 */

export type ReportBlockerCode =
  | "stripe_unconfigured"
  | "stripe_misconfigured"
  | "webhook_unconfigured"
  | "webhook_misconfigured"
  | "dashboard_url_missing"
  | "stripe_sandbox_not_verified"
  | "stripe_sandbox_unreachable"
  | "settlement_mapping_unprovisioned"
  | `sandbox_${SandboxFindingCode}`

export type ReportBlocker = { code: ReportBlockerCode; subject?: string; text: string }

export type SandboxReport = {
  status: "READY" | "NOT_READY"
  contract: { status: typeof SANDBOX_CONTRACT_STATUS; meterApiVersion: string }
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
  stripe_sandbox_not_verified: "The sandbox was not read. Re-run with --network (an explicit, read-only Stripe test-mode check).",
  stripe_sandbox_unreachable: "The Stripe sandbox could not be read (network, key or API version). Nothing was changed.",
  settlement_mapping_unprovisioned: "REVIEWED_SETTLEMENT_METER_MAPPING is unprovisioned. After the meters verify and the founder confirms the contract, a reviewed commit names them. No environment variable can do this.",
}

export function buildSandboxReport(input: {
  env: Record<string, string | undefined>
  verification: SandboxVerification | "skipped"
  mappingStatus?: "unprovisioned" | "provisioned"
}): SandboxReport {
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

  if ((input.mappingStatus ?? REVIEWED_SETTLEMENT_METER_MAPPING.status) !== "provisioned") {
    blockers.push({ code: "settlement_mapping_unprovisioned", text: BLOCKER_TEXT.settlement_mapping_unprovisioned })
  }

  return {
    status: blockers.length === 0 ? "READY" : "NOT_READY",
    contract: { status: SANDBOX_CONTRACT_STATUS, meterApiVersion: COMMERCIAL_METER_API_VERSION },
    blockers,
    expected: {
      baseLookupKey: SANDBOX_BASE_PRICE.lookupKey,
      meters: SANDBOX_METERS.map((m) => ({
        component: m.component, eventName: m.eventName, meteredPriceLookupKey: m.meteredPriceLookupKey, unitAmountCents: m.meteredUnitAmountCents,
      })),
    },
    manualSteps: SANDBOX_MANUAL_STEPS,
    notVerifiedHere: [
      "Metered Prices attached to the subscription and the webhook rule that accepts them (PR F2; a founder decision).",
      "A real Stripe test-clock run, including that usage reaches Stripe before the renewal invoice finalizes (PR F2).",
      "The webhook endpoint exists, is pinned to the reviewed API version and delivers (Dashboard step; not read by this command).",
      "Customer Portal configuration (founder decision).",
      "Anything in live mode. This command refuses live configuration and never touches production.",
    ],
  }
}

export function formatSandboxReport(report: SandboxReport): string {
  const lines: string[] = []
  lines.push(`SANDBOX ACCEPTANCE: ${report.status}`)
  lines.push(`Contract status: ${report.contract.status} (meter API version ${report.contract.meterApiVersion})`)
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
