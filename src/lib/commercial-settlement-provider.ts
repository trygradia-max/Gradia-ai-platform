import { StripeError, stripeCommercialRequest, type CommercialStripeTransportConfig } from "@/lib/stripe"
import { isDefinitiveRejection } from "@/lib/stripe-commercial"
import { COMMERCIAL_METER_API_VERSION } from "@/lib/stripe-sandbox-contract"

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

export function createSettlementProvider(
  config: CommercialStripeTransportConfig,
  request: typeof stripeCommercialRequest = stripeCommercialRequest
): SettlementProvider {
  return {
    submitMeterEvent(event) {
      return request<unknown>(config, {
        method: "POST",
        path: "/billing/meter_events",
        idempotencyKey: event.identifier,
        apiVersion: COMMERCIAL_METER_API_VERSION,
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

// ---------------------------------------------------------------------------
// Read-only reconciliation evidence (PR F)
// ---------------------------------------------------------------------------

export type MeterEvidenceQuery = {
  eventName: string
  customerId: string
  /** Minute-aligned unix seconds; the window is [start, start + 60). */
  startSeconds: number
}

/**
 * What the provider REPORTS it aggregated for one customer in one minute on one meter. Evidence
 * only: it never resends, creates or changes anything. Throws on anything unreadable or
 * ambiguous (unresolvable meter, live object, paginated result) so the caller records nothing.
 */
export type MeterEvidenceReader = {
  readObservedTotal(query: MeterEvidenceQuery): Promise<number>
}

type ListEnvelope = { data?: unknown; has_more?: unknown }

export function createMeterEvidenceReader(
  config: CommercialStripeTransportConfig,
  request: typeof stripeCommercialRequest = stripeCommercialRequest
): MeterEvidenceReader {
  const get = <T>(path: string, body?: Record<string, string | number>) =>
    request<T>(config, { method: "GET", path, body, apiVersion: COMMERCIAL_METER_API_VERSION })
  return {
    async readObservedTotal(query) {
      if (!Number.isInteger(query.startSeconds) || query.startSeconds % 60 !== 0) throw new Error("window_not_minute_aligned")
      const meters = await get<ListEnvelope>("/billing/meters", { limit: 100 })
      if (!Array.isArray(meters.data) || meters.has_more !== false) throw new Error("meters_unreadable")
      const matching = (meters.data as Record<string, unknown>[]).filter(
        (meter) => meter?.event_name === query.eventName && meter?.status === "active"
      )
      if (matching.length !== 1 || typeof matching[0].id !== "string" || matching[0].livemode !== false) throw new Error("meter_unresolved")
      const meterId = matching[0].id
      const summaries = await get<ListEnvelope>(`/billing/meters/${encodeURIComponent(meterId)}/event_summaries`, {
        customer: query.customerId,
        start_time: query.startSeconds,
        end_time: query.startSeconds + 60,
        limit: 100,
      })
      if (!Array.isArray(summaries.data) || summaries.has_more !== false) throw new Error("summaries_unreadable")
      let total = 0
      for (const raw of summaries.data as Record<string, unknown>[]) {
        if (raw?.object !== "billing.meter_event_summary" || raw.livemode !== false || raw.meter !== meterId) throw new Error("summary_unreadable")
        const value = raw.aggregated_value
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("summary_unreadable")
        total += value
      }
      return total
    },
  }
}
