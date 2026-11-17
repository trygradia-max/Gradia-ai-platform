import { classifyProviderFailure, type ProviderFailureClass } from "@/lib/commercial-settlement-provider"
import { stripeCommercialRequest, type CommercialStripeTransportConfig } from "@/lib/stripe"
import { COMMERCIAL_METER_API_VERSION } from "@/lib/stripe-sandbox-contract"

/**
 * Provider boundary for carrying ONE human-approved signed adjustment to the next invoice
 * (Commercial Billing PR F). Exactly one operation: a PENDING invoice item for the bound
 * platform customer, which Stripe attaches to the customer's next invoice. It accepts no
 * metric, price, tenant or period from a caller: the service passes the database claim through
 * unchanged. PLATFORM only, test mode only, no refund / credit-note / payment / cancel call.
 */

export type AdjustmentInvoiceItem = {
  customerId: string
  /** Signed integer cents. Negative reduces the next invoice (a credit toward the customer). */
  signedAmountCents: number
  /** The deterministic local identity; also the provider Idempotency-Key. */
  identifier: string
}

export type AdjustmentProvider = {
  /** Resolves with the provider's raw acknowledgement, or throws. */
  createPendingInvoiceItem(item: AdjustmentInvoiceItem): Promise<unknown>
}

export const ADJUSTMENT_DESCRIPTION = "Gradia billing adjustment"

export function createAdjustmentProvider(
  config: CommercialStripeTransportConfig,
  request: typeof stripeCommercialRequest = stripeCommercialRequest
): AdjustmentProvider {
  return {
    createPendingInvoiceItem(item) {
      return request<unknown>(config, {
        method: "POST",
        path: "/invoiceitems",
        idempotencyKey: item.identifier,
        apiVersion: COMMERCIAL_METER_API_VERSION,
        body: {
          customer: item.customerId,
          amount: item.signedAmountCents,
          currency: "usd",
          description: ADJUSTMENT_DESCRIPTION,
          "metadata[gradia_adjustment_ref]": item.identifier,
        },
      })
    },
  }
}

export type InvoiceItemAckCheck =
  | { ok: true }
  | { ok: false; code: "live_object_refused" | "response_mismatch" | "unreadable_response" | "attached_to_invoice" }

/**
 * Accepted only when it is exactly the pending item we asked for: test mode, same customer,
 * same signed amount, USD, and NOT already attached to an invoice (an item that already rode
 * a different invoice is ambiguous about which invoice it hit, so it is `unknown`).
 */
export function verifyInvoiceItemAck(ack: unknown, expected: AdjustmentInvoiceItem): InvoiceItemAckCheck {
  if (!ack || typeof ack !== "object") return { ok: false, code: "unreadable_response" }
  const a = ack as Record<string, unknown>
  if (a.object !== "invoiceitem" || typeof a.livemode !== "boolean" || typeof a.amount !== "number") {
    return { ok: false, code: "unreadable_response" }
  }
  if (a.livemode !== false) return { ok: false, code: "live_object_refused" }
  const customer = typeof a.customer === "string" ? a.customer : (a.customer as { id?: unknown } | null)?.id
  if (customer !== expected.customerId || a.amount !== expected.signedAmountCents || a.currency !== "usd") {
    return { ok: false, code: "response_mismatch" }
  }
  if (a.invoice !== null && a.invoice !== undefined) return { ok: false, code: "attached_to_invoice" }
  return { ok: true }
}

export type { ProviderFailureClass }
export { classifyProviderFailure }
