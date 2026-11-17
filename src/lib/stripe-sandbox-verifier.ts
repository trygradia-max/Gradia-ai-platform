import {
  COMMERCIAL_METER_API_VERSION,
  SANDBOX_REQUIRED_PRICE_LOOKUP_KEYS,
  evaluateSandboxReadiness,
  type SandboxReadiness,
  type SandboxSnapshot,
} from "@/lib/stripe-sandbox-contract"
import { resolveCommercialStripeConfig } from "@/lib/stripe-commercial"
import { stripeCommercialRequest, type CommercialStripeTransportConfig } from "@/lib/stripe"

/**
 * Read-only Stripe SANDBOX reader (Commercial Billing PR F). GET requests only, PLATFORM
 * account only, test-mode configuration only (the same refused-if-live config PR C uses),
 * one reviewed API version, and no object ids, secrets or payloads in any output. It creates
 * and changes nothing in Stripe.
 */

export type SandboxReadFailure = "billing_unconfigured" | "billing_misconfigured" | "provider_unreachable"

type ListEnvelope = { data?: unknown; has_more?: unknown }

/** Pure-ish: the transport is injected so a fake can stand in. Never throws. */
export async function collectSandboxSnapshot(
  config: CommercialStripeTransportConfig,
  request: typeof stripeCommercialRequest = stripeCommercialRequest
): Promise<SandboxSnapshot | { failure: "provider_unreachable" }> {
  const meta = { stripeVersion: null as string | null }
  const get = <T>(path: string, body?: Record<string, string | number | boolean>) =>
    request<T>(config, { method: "GET", path, body, apiVersion: COMMERCIAL_METER_API_VERSION, responseMeta: meta })

  const pricesByLookupKey: Record<string, unknown[] | null> = {}
  for (const key of SANDBOX_REQUIRED_PRICE_LOOKUP_KEYS) {
    try {
      const list = await get<ListEnvelope>("/prices", {
        "lookup_keys[0]": key,
        "expand[0]": "data.product",
        limit: 3,
      })
      // More than one match (limit 3, so up to 3 are visible) is reported as a duplicate by the evaluator.
      pricesByLookupKey[key] = Array.isArray(list.data) ? list.data : null
    } catch {
      pricesByLookupKey[key] = null
    }
  }

  let meters: unknown[] | null = null
  let metersComplete = false
  try {
    const list = await get<ListEnvelope>("/billing/meters", { limit: 100 })
    if (Array.isArray(list.data)) {
      meters = list.data
      metersComplete = list.has_more === false
    }
  } catch {
    meters = null
  }

  if (meters === null && Object.values(pricesByLookupKey).every((v) => v === null)) return { failure: "provider_unreachable" }
  return { echoedApiVersion: meta.stripeVersion, pricesByLookupKey, meters, metersComplete }
}

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
