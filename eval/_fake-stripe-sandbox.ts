import { StripeError, type stripeCommercialRequest } from "@/lib/stripe"
import { COMMERCIAL_METER_API_VERSION, SANDBOX_BASE_PRICE, SANDBOX_METERS, SANDBOX_PRODUCT } from "@/lib/stripe-sandbox-contract"

/**
 * A faithful LOCAL stand-in for the slice of Stripe TEST mode that Commercial Billing PR F uses.
 * It is injected as the `request` function of the REAL provider code, so request shapes, headers,
 * parsing and classification are the production ones. It never touches the network.
 *
 * Modelled provider behaviour (each line is something the docs state or the code relies on):
 *  - meter events: `identifier` uniqueness (a repeat returns the stored event and never counts twice),
 *    timestamp window (past 35 days .. +5 minutes), unknown event name -> 400, event value must be
 *    a positive integer string;
 *  - event summaries: minute-aligned windows, sum per customer per meter by EVENT timestamp;
 *  - pending invoice items: Idempotency-Key replay, signed amounts, ride the NEXT invoice;
 *  - invoices: base price + metered usage (events whose timestamp is in the period AND that were
 *    received before the invoice finalized) + pending invoice items. Usage received after
 *    finalization is recorded as `late_unbilled` (the finalization race, never silently billed).
 */

type Meter = { id: string; event_name: string; status: string; livemode: boolean; component: string; unitCents: number; [k: string]: unknown }
type StoredEvent = { identifier: string; eventName: string; customer: string; value: number; timestamp: number; receivedAt: number }
type StoredItem = { identifier: string; customer: string; amount: number; invoice: string | null; livemode: boolean }

export type FakeFailure = "timeout_after_record" | "timeout_before_record" | "http_500" | "reject_400" | "bad_ack"

export type FakeInvoice = {
  id: string
  customer: string
  periodStart: number
  periodEnd: number
  baseCents: number
  meteredCents: number
  adjustmentCents: number
  totalCents: number
  lateUnbilledEventCount: number
  lines: { component: string; value: number; unitCents: number; cents: number }[]
  finalizedAt: number
}

export class FakeStripeSandbox {
  /** Unix seconds of the fake "test clock". */
  clock: number
  echoedVersion: string | null = COMMERCIAL_METER_API_VERSION
  meters: Meter[] = []
  prices: Record<string, unknown[]> = {}
  /** When true the event-summaries endpoint reports nothing (asynchronous processing lag). */
  summariesLag = false
  readonly events = new Map<string, StoredEvent>()
  readonly items = new Map<string, StoredItem>()
  readonly invoices: FakeInvoice[] = []
  readonly calls: { method: string; path: string; apiVersion?: string; idempotencyKey?: string }[] = []
  duplicateMeterEventAttempts = 0
  private failures: FakeFailure[] = []
  private seq = 0

  constructor(clock: number) {
    this.clock = clock
  }

  /** A sandbox that satisfies the whole contract. */
  static provisioned(clock: number): FakeStripeSandbox {
    const fake = new FakeStripeSandbox(clock)
    const product = { id: "prod_FakeFounderPilot", object: "product", active: true, livemode: false, name: SANDBOX_PRODUCT.name, metadata: { ...SANDBOX_PRODUCT.metadata } }
    fake.prices[SANDBOX_BASE_PRICE.lookupKey] = [{
      id: "price_FakeBase1", object: "price", active: true, livemode: false, currency: "usd", lookup_key: SANDBOX_BASE_PRICE.lookupKey,
      type: "recurring", billing_scheme: "per_unit", unit_amount: SANDBOX_BASE_PRICE.unitAmountCents, product,
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    }]
    for (const spec of SANDBOX_METERS) {
      const id = `mtr_test_Fake_${spec.component}`
      fake.meters.push({
        id, object: "billing.meter", livemode: false, status: "active", event_name: spec.eventName, component: spec.component,
        unitCents: spec.meteredUnitAmountCents, default_aggregation: { formula: "sum" },
        customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" }, event_time_window: null,
      })
      fake.prices[spec.meteredPriceLookupKey] = [{
        id: `price_Fake_${spec.component}`, object: "price", active: true, livemode: false, currency: "usd", lookup_key: spec.meteredPriceLookupKey,
        type: "recurring", billing_scheme: "per_unit", unit_amount: spec.meteredUnitAmountCents, product,
        recurring: { interval: "month", interval_count: 1, usage_type: "metered", meter: id },
      }]
    }
    return fake
  }

  /** Make the NEXT meter-event / invoice-item write fail in the given way. */
  failNext(failure: FakeFailure) {
    this.failures.push(failure)
  }

  /** The `request` function injected into the real provider code. */
  request = (async (_config, input) => {
    this.calls.push({ method: input.method, path: input.path, apiVersion: input.apiVersion, idempotencyKey: input.idempotencyKey })
    if (input.responseMeta) input.responseMeta.stripeVersion = this.echoedVersion
    const body = input.body ?? {}
    if (input.method === "GET" && input.path === "/prices") {
      const key = String(body["lookup_keys[0]"])
      return { object: "list", data: this.prices[key] ?? [], has_more: false } as never
    }
    if (input.method === "GET" && input.path === "/billing/meters") {
      return { object: "list", data: this.meters.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== "component" && k !== "unitCents"))), has_more: false } as never
    }
    const summary = /^\/billing\/meters\/([^/]+)\/event_summaries$/.exec(input.path)
    if (input.method === "GET" && summary) return this.summaries(decodeURIComponent(summary[1]), body) as never
    if (input.method === "POST" && input.path === "/billing/meter_events") return this.meterEvent(body, input.idempotencyKey) as never
    if (input.method === "POST" && input.path === "/invoiceitems") return this.invoiceItem(body, input.idempotencyKey) as never
    throw new StripeError(404, "Unknown fake route", "resource_missing")
  }) as typeof stripeCommercialRequest

  private takeFailure(): FakeFailure | undefined {
    return this.failures.shift()
  }

  private meterEvent(body: Record<string, string | number | boolean | undefined | null>, idempotencyKey?: string) {
    const failure = this.takeFailure()
    if (failure === "timeout_before_record") throw new StripeError(0, "Stripe request timed out", "timeout")
    if (failure === "http_500") throw new StripeError(500, "Stripe request rejected", null)
    if (failure === "reject_400") throw new StripeError(400, "Stripe request rejected", "invalid_request")
    const name = String(body.event_name)
    const meter = this.meters.find((m) => m.event_name === name && m.status === "active")
    if (!meter) throw new StripeError(400, "No meter", "meter_event_customer_not_found")
    const value = String(body["payload[value]"])
    const customer = String(body["payload[stripe_customer_id]"])
    const timestamp = Number(body.timestamp)
    const identifier = String(body.identifier)
    if (idempotencyKey !== undefined && idempotencyKey !== identifier) throw new StripeError(400, "Mismatched keys", "idempotency_error")
    if (!/^[1-9][0-9]*$/.test(value)) throw new StripeError(400, "Invalid value", "invalid_request")
    if (timestamp < this.clock - 35 * 86_400 || timestamp > this.clock + 300) throw new StripeError(400, "Timestamp out of range", "timestamp_too_far_in_past")
    let stored = this.events.get(identifier)
    if (stored) {
      this.duplicateMeterEventAttempts++
    } else {
      stored = { identifier, eventName: name, customer, value: Number(value), timestamp, receivedAt: this.clock }
      this.events.set(identifier, stored)
    }
    if (failure === "timeout_after_record") throw new StripeError(0, "Stripe request timed out", "timeout")
    return {
      object: "billing.meter_event", created: this.clock, event_name: name, identifier, livemode: false,
      payload: { stripe_customer_id: customer, value: failure === "bad_ack" ? "999999" : String(stored.value) }, timestamp: stored.timestamp,
    }
  }

  private summaries(meterId: string, body: Record<string, string | number | boolean | undefined | null>) {
    const meter = this.meters.find((m) => m.id === meterId)
    if (!meter) throw new StripeError(404, "No such meter", "resource_missing")
    const start = Number(body.start_time)
    const end = Number(body.end_time)
    if (start % 60 !== 0 || end % 60 !== 0) throw new StripeError(400, "Not minute aligned", "invalid_request")
    let total = 0
    if (!this.summariesLag) {
      for (const ev of this.events.values()) {
        if (ev.eventName === meter.event_name && ev.customer === String(body.customer) && ev.timestamp >= start && ev.timestamp < end) total += ev.value
      }
    }
    return {
      object: "list", has_more: false,
      data: [{ id: "mtrusg_test_fake", object: "billing.meter_event_summary", aggregated_value: total, start_time: start, end_time: end, livemode: false, meter: meterId }],
    }
  }

  private invoiceItem(body: Record<string, string | number | boolean | undefined | null>, idempotencyKey?: string) {
    const failure = this.takeFailure()
    if (failure === "timeout_before_record") throw new StripeError(0, "Stripe request timed out", "timeout")
    if (failure === "http_500") throw new StripeError(500, "Stripe request rejected", null)
    if (failure === "reject_400") throw new StripeError(400, "Stripe request rejected", "invalid_request")
    if (!idempotencyKey) throw new StripeError(400, "Idempotency-Key required by this fake", "idempotency_error")
    let stored = this.items.get(idempotencyKey)
    if (!stored) {
      stored = { identifier: idempotencyKey, customer: String(body.customer), amount: Number(body.amount), invoice: null, livemode: false }
      this.items.set(idempotencyKey, stored)
    }
    if (failure === "timeout_after_record") throw new StripeError(0, "Stripe request timed out", "timeout")
    return {
      id: `ii_fake_${++this.seq}`, object: "invoiceitem", livemode: false, customer: stored.customer,
      amount: failure === "bad_ack" ? stored.amount + 1 : stored.amount, currency: String(body.currency), invoice: stored.invoice,
    }
  }

  /**
   * Finalizes the renewal invoice of one subscription period at `finalizedAt` (fake clock). Usage is
   * billed only if the event's timestamp is inside the period AND it was received before finalization.
   * Pending invoice items for the customer ride this invoice (they are the NEXT invoice's adjustments).
   */
  finalizeInvoice(args: { customer: string; periodStart: number; periodEnd: number; finalizedAt: number }): FakeInvoice {
    const lines: FakeInvoice["lines"] = []
    let lateUnbilled = 0
    for (const meter of this.meters) {
      let value = 0
      for (const ev of this.events.values()) {
        if (ev.eventName !== meter.event_name || ev.customer !== args.customer) continue
        if (ev.timestamp < args.periodStart || ev.timestamp >= args.periodEnd) continue
        if (ev.receivedAt <= args.finalizedAt) value += ev.value
        else lateUnbilled++
      }
      if (value > 0) lines.push({ component: meter.component, value, unitCents: meter.unitCents, cents: value * meter.unitCents })
    }
    let adjustment = 0
    for (const item of this.items.values()) {
      if (item.customer === args.customer && item.invoice === null) {
        adjustment += item.amount
        item.invoice = `in_fake_${this.invoices.length + 1}`
      }
    }
    const metered = lines.reduce((sum, line) => sum + line.cents, 0)
    const invoice: FakeInvoice = {
      id: `in_fake_${this.invoices.length + 1}`, customer: args.customer, periodStart: args.periodStart, periodEnd: args.periodEnd,
      baseCents: SANDBOX_BASE_PRICE.unitAmountCents, meteredCents: metered, adjustmentCents: adjustment,
      totalCents: SANDBOX_BASE_PRICE.unitAmountCents + metered + adjustment, lateUnbilledEventCount: lateUnbilled, lines, finalizedAt: args.finalizedAt,
    }
    this.invoices.push(invoice)
    return invoice
  }
}
