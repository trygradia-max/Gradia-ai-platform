import {
  COMMERCIAL_METER_API_VERSION,
  SANDBOX_REQUIRED_PRICE_LOOKUP_KEYS,
  type SandboxSnapshot,
} from "@/lib/stripe-sandbox-contract"
import { stripeCommercialRequest, type CommercialStripeTransportConfig } from "@/lib/stripe"

/**
 * Read-only Stripe SANDBOX snapshot collector (Commercial Billing PR F / F2). GET requests only,
 * PLATFORM account only, one reviewed API version, no ids/secrets/payloads in any output.
 * Split out of the verifier so the Checkout client can resolve the exact item set without an
 * import cycle (the verifier imports the Stripe config module; the config module's client imports this).
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

