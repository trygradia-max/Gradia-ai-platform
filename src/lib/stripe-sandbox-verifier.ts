import {
  evaluateSandboxReadiness,
  type SandboxReadiness,
} from "@/lib/stripe-sandbox-contract"
import { resolveCommercialStripeConfig } from "@/lib/stripe-commercial"
import { stripeCommercialRequest } from "@/lib/stripe"
import { collectSandboxSnapshot, type SandboxReadFailure } from "@/lib/stripe-sandbox-snapshot"

export { collectSandboxSnapshot, type SandboxReadFailure }

/**
 * Read-only Stripe SANDBOX reader (Commercial Billing PR F). GET requests only, PLATFORM
 * account only, test-mode configuration only (the same refused-if-live config PR C uses),
 * one reviewed API version, and no object ids, secrets or payloads in any output. It creates
 * and changes nothing in Stripe.
 */

export type SandboxVerification =
  | { status: "not_run"; reason: SandboxReadFailure }
  | ({ status: "checked" } & SandboxReadiness)

/** Reads the sandbox and judges it. Network happens only here, and only for the explicit operator command. */
export async function verifyStripeSandbox(
  env: Record<string, string | undefined> = process.env,
  request: typeof stripeCommercialRequest = stripeCommercialRequest
): Promise<SandboxVerification> {
  const config = resolveCommercialStripeConfig(env)
  if (!config.ok) return { status: "not_run", reason: config.reason }
  const snapshot = await collectSandboxSnapshot(config.config, request)
  if ("failure" in snapshot) return { status: "not_run", reason: "provider_unreachable" }
  return { status: "checked", ...evaluateSandboxReadiness(snapshot) }
}
