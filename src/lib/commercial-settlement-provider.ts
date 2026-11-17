import { StripeError, stripeCommercialRequest, type CommercialStripeTransportConfig } from "@/lib/stripe"
import { isDefinitiveRejection } from "@/lib/stripe-commercial"

/**
 * The provider boundary for settlement deliveries (Commercial Billing PR D).
 *
 * Narrow on purpose: one operation, `submitMeterEvent`, that sends exactly the
 * event the database handed out for a claimed line. It accepts no metric name,
 * price or customer chosen by a caller — the service passes the claim payload
 * through unchanged. PLATFORM billing only (no connected-account parameter),
 * test mode only (the transport config is the same refused-if-live config that PR
 * C uses), and the raw response is returned for strict verification, never logged.
 *
 * Automated tests substitute a local fake for this type; nothing here runs against
 * the network in tests.
 */

export type SettlementMeterEvent = {
  eventName: string
  customerId: string
  /** Whole-unit decimal string (a positive integer). */
  value: string
  /** The deterministic local identity of this line; also the provider idempotency key. */
  identifier: string
  /** Unix seconds: the last second of the closed window. */
  timestampSeconds: number
}

export type SettlementProvider = {
  /** Resolves with the provider's raw acknowledgement, or throws. Outcome classification is the caller's. */
  submitMeterEvent(event: SettlementMeterEvent): Promise<unknown>
}

export function createSettlementProvider(config: CommercialStripeTransportConfig): SettlementProvider {
  return {
    submitMeterEvent(event) {
      return stripeCommercialRequest<unknown>(config, {
        method: "POST",
        path: "/billing/meter_events",
        idempotencyKey: event.identifier,
        body: {
          event_name: event.eventName,
          identifier: event.identifier,
          timestamp: event.timestampSeconds,
          "payload[stripe_customer_id]": event.customerId,
          "payload[value]": event.value,
        },
      })
    },
  }
}

export type ProviderFailureClass = "rejected" | "unknown"

/**
 * A 4xx rejection means the provider did not act. Everything else — timeout,
 * transport error, 409/429/5xx or any non-Stripe throw — may have acted: UNKNOWN.
 * (Same rule as the PR C Checkout classification.)
 */
export function classifyProviderFailure(error: unknown): { outcome: ProviderFailureClass; code: string } {
  if (isDefinitiveRejection(error)) return { outcome: "rejected", code: "provider_rejected" }
  if (error instanceof StripeError) return { outcome: "unknown", code: "provider_outcome_unknown" }
  return { outcome: "unknown", code: "provider_outcome_unknown" }
}
