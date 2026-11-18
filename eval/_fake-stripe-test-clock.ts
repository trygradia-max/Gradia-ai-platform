import { StripeError, type stripeCommercialRequest } from "@/lib/stripe"
import { SANDBOX_BASE_PRICE } from "@/lib/stripe-sandbox-contract"
import { FakeStripeSandbox } from "./_fake-stripe-sandbox"

/**
 * A LOCAL stand-in for the slice of Stripe TEST mode (test clocks, customers, payment methods, Checkout Sessions,
 * subscriptions, invoices, meter events) used by the F2 acceptance harness. It never touches the network.
 * It encodes ASSUMPTIONS about Stripe (documented below) so the harness LOGIC can be tested offline; it proves nothing
 * about real Stripe, which is exactly why the real run is a separate, opt-in, human-run command.
 *
 * Assumptions: advancing a clock first reports `advancing` once; a renewal invoice finalizes one hour after the period
 * boundary; usage received (clock time) before finalization is billed, later usage is never billed; a card flagged
 * `fail` leaves the renewal invoice `open` and the subscription `past_due`; paying an open invoice with a good card
 * makes the subscription `active`; deleting a clock deletes its customers and subscriptions.
 */
type Pm = { id: string; kind: "visa" | "fail"; customer: string }
type Customer = { id: string; clock: string; defaultPm: string | null; deleted: boolean }
type Sub = { id: string; customer: string; status: string; start: number; periodStart: number; periodEnd: number; items: { priceId: string; quantity?: number }[]; canceled: boolean }
type Inv = { id: string; customer: string; subscription: string; status: "paid" | "open"; total: number; attemptCount: number; created: number; billingReason: string }
type Clock = { id: string; frozen: number; status: "ready" | "advancing"; deleted: boolean; polls: number }

export type TestClockFakeOptions = {
  previewUnsupported?: boolean
  deleteClockFails?: boolean
  /** Report livemode:true on the customer (a live-shaped object must abort the run). */
  liveCustomer?: boolean
  rejectSubscription?: boolean
}

const addMonth = (seconds: number) => {
  const d = new Date(seconds * 1000)
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000)
}

export class FakeTestClockStripe extends FakeStripeSandbox {
  readonly clocks = new Map<string, Clock>()
  readonly customers = new Map<string, Customer>()
  readonly pms = new Map<string, Pm>()
  readonly subs = new Map<string, Sub>()
  readonly stripeInvoices = new Map<string, Inv>()
  readonly sessions = new Map<string, { status: string; customer: string; items: { priceId: string; quantity?: number }[]; shopId: string; attemptId: string }>()
  readonly requests: { method: string; path: string; idempotencyKey?: string }[] = []
  options: TestClockFakeOptions = {}
  private n = 0

  static clockSandbox(realNow: number, options: TestClockFakeOptions = {}): FakeTestClockStripe {
    const fake = new FakeTestClockStripe(realNow)
    // Reuse the contract-satisfying sandbox data.
    const provisioned = FakeStripeSandbox.provisioned(realNow)
    fake.meters = provisioned.meters
    fake.prices = provisioned.prices
    fake.options = options
    return fake
  }

  constructor(realNow: number) {
    super(realNow)
    const base = this.request
    this.request = (async (config, input) => {
      this.requests.push({ method: input.method, path: input.path, idempotencyKey: input.idempotencyKey })
      const routed = this.route(input as never)
      if (routed !== undefined) return routed as never
      return base(config, input)
    }) as typeof stripeCommercialRequest
  }

  protected override receiveTime(customer: string): number {
    const c = this.customers.get(customer)
    return c ? (this.clocks.get(c.clock)?.frozen ?? this.clock) : this.clock
  }

  private id(prefix: string) {
    return `${prefix}_Fake${(++this.n).toString().padStart(4, "0")}`
  }
  private body(input: { body?: Record<string, string | number | boolean | undefined | null> }) {
    return (input.body ?? {}) as Record<string, string | number | boolean | undefined | null>
  }
  private priceById(id: string) {
    for (const list of Object.values(this.prices)) for (const p of list as Record<string, unknown>[]) if (p.id === id) return p
    return null
  }
  private itemObject(i: { priceId: string; quantity?: number }) {
    const price = this.priceById(i.priceId) as Record<string, unknown>
    const metered = (price.recurring as { usage_type: string }).usage_type === "metered"
    return { id: this.id("si"), object: "subscription_item", ...(metered ? { quantity: null } : { quantity: i.quantity ?? 1 }), price: { ...price, product: (price.product as { id: string }).id } }
  }
  private lineItems(items: { priceId: string; quantity?: number }[]) {
    return { object: "list", data: items.map((i) => ({ ...this.itemObject(i), object: "item" })) }
  }
  private subObject(sub: Sub) {
    return {
      id: sub.id, object: "subscription", customer: sub.customer, status: sub.status, livemode: false, start_date: sub.start,
      current_period_start: sub.periodStart, current_period_end: sub.periodEnd, cancel_at_period_end: false,
      canceled_at: sub.canceled ? this.clocks.get(this.customers.get(sub.customer)!.clock)!.frozen : null, metadata: {},
      items: { object: "list", data: sub.items.map((i) => this.itemObject(i)) },
    }
  }
  private invObject(inv: Inv) {
    return { id: inv.id, object: "invoice", livemode: false, customer: inv.customer, subscription: inv.subscription, status: inv.status, total: inv.total,
      amount_paid: inv.status === "paid" ? inv.total : 0, attempt_count: inv.attemptCount, created: inv.created, billing_reason: inv.billingReason }
  }
  private usageCents(customer: string, ps: number, pe: number, receivedBy: number) {
    let cents = 0
    for (const ev of this.events.values()) {
      if (ev.customer !== customer || ev.timestamp < ps || ev.timestamp >= pe || ev.receivedAt > receivedBy) continue
      const meter = this.meters.find((m) => m.event_name === ev.eventName)
      if (meter) cents += ev.value * meter.unitCents
    }
    return cents
  }

  private bill(clock: Clock) {
    for (const sub of this.subs.values()) {
      const customer = this.customers.get(sub.customer)!
      if (customer.clock !== clock.id || sub.canceled || sub.status === "canceled") continue
      while (clock.frozen >= sub.periodEnd + 3600) {
        const pm = customer.defaultPm ? this.pms.get(customer.defaultPm) : undefined
        const usage = this.usageCents(sub.customer, sub.periodStart, sub.periodEnd, sub.periodEnd + 3600)
        const inv: Inv = {
          id: this.id("in"), customer: sub.customer, subscription: sub.id, total: SANDBOX_BASE_PRICE.unitAmountCents + usage,
          status: pm?.kind === "visa" ? "paid" : "open", attemptCount: pm?.kind === "visa" ? 1 : 1, created: sub.periodEnd + 3600, billingReason: "subscription_cycle",
        }
        this.stripeInvoices.set(inv.id, inv)
        if (inv.status === "open") sub.status = "past_due"
        sub.periodStart = sub.periodEnd
        sub.periodEnd = addMonth(sub.periodStart)
      }
    }
  }

  private route(input: { method: string; path: string; body?: Record<string, string | number | boolean | undefined | null>; idempotencyKey?: string }): unknown | undefined {
    const { method, path } = input
    const body = this.body(input)
    let m: RegExpExecArray | null
    if (method === "POST" && path === "/test_helpers/test_clocks") {
      const clock: Clock = { id: this.id("clock"), frozen: Number(body.frozen_time), status: "ready", deleted: false, polls: 0 }
      this.clocks.set(clock.id, clock)
      return { id: clock.id, object: "test_helpers.test_clock", frozen_time: clock.frozen, status: "ready", livemode: false }
    }
    if ((m = /^\/test_helpers\/test_clocks\/([^/]+)$/.exec(path))) {
      const clock = this.clocks.get(m[1])
      if (!clock || clock.deleted) throw new StripeError(404, "No such clock", "resource_missing")
      if (method === "GET") {
        if (clock.status === "advancing" && clock.polls++ >= 1) clock.status = "ready"
        return { id: clock.id, object: "test_helpers.test_clock", frozen_time: clock.frozen, status: clock.status, livemode: false }
      }
      if (method === "DELETE") {
        if (this.options.deleteClockFails) throw new StripeError(500, "boom", null)
        clock.deleted = true
        for (const c of this.customers.values()) if (c.clock === clock.id) c.deleted = true
        for (const s of this.subs.values()) if (this.customers.get(s.customer)?.clock === clock.id) s.status = "canceled"
        return { id: clock.id, object: "test_helpers.test_clock", deleted: true }
      }
    }
    if ((m = /^\/test_helpers\/test_clocks\/([^/]+)\/advance$/.exec(path)) && method === "POST") {
      const clock = this.clocks.get(m[1])
      if (!clock || clock.deleted) throw new StripeError(404, "No such clock", "resource_missing")
      const to = Number(body.frozen_time)
      if (!(to > clock.frozen)) throw new StripeError(400, "must advance", "invalid_request")
      clock.frozen = to
      clock.status = "advancing"
      clock.polls = 0
      this.bill(clock)
      return { id: clock.id, object: "test_helpers.test_clock", frozen_time: to, status: "advancing", livemode: false }
    }
    if (method === "POST" && path === "/customers") {
      const customer: Customer = { id: this.id("cus"), clock: String(body.test_clock), defaultPm: null, deleted: false }
      const pm: Pm = { id: this.id("pm"), kind: "visa", customer: customer.id }
      this.pms.set(pm.id, pm)
      customer.defaultPm = pm.id
      this.customers.set(customer.id, customer)
      return { id: customer.id, object: "customer", livemode: this.options.liveCustomer === true, invoice_settings: { default_payment_method: pm.id } }
    }
    if ((m = /^\/customers\/([^/]+)$/.exec(path)) && method === "POST") {
      const customer = this.customers.get(m[1])
      if (!customer) throw new StripeError(404, "No such customer", "resource_missing")
      const pmId = String(body["invoice_settings[default_payment_method]"])
      if (!this.pms.has(pmId)) throw new StripeError(400, "No such payment method", "resource_missing")
      customer.defaultPm = pmId
      return { id: customer.id, object: "customer", livemode: false }
    }
    if ((m = /^\/payment_methods\/([^/]+)\/attach$/.exec(path)) && method === "POST") {
      const pm: Pm = { id: this.id("pm"), kind: m[1] === "pm_card_chargeCustomerFail" ? "fail" : "visa", customer: String(body.customer) }
      this.pms.set(pm.id, pm)
      return { id: pm.id, object: "payment_method", livemode: false }
    }
    if (method === "POST" && path === "/checkout/sessions") {
      const items: { priceId: string; quantity?: number }[] = []
      for (let i = 0; body[`line_items[${i}][price]`] !== undefined; i += 1) {
        const price = this.priceById(String(body[`line_items[${i}][price]`]))
        const quantity = body[`line_items[${i}][quantity]`]
        if (!price) throw new StripeError(400, "No such price", "resource_missing")
        const metered = (price.recurring as { usage_type: string }).usage_type === "metered"
        if (metered && quantity !== undefined) throw new StripeError(400, "quantity must not be defined for metered prices", "parameter_invalid_empty")
        items.push({ priceId: String(price.id), ...(quantity !== undefined ? { quantity: Number(quantity) } : {}) })
      }
      const id = `cs_test_Fake${(++this.n).toString().padStart(4, "0")}`
      this.sessions.set(id, { status: "open", customer: String(body.customer), items, shopId: String(body["metadata[shop_id]"]), attemptId: String(body["metadata[checkout_attempt_id]"]) })
      return { id, object: "checkout.session", livemode: false, mode: "subscription", status: "open", url: `https://checkout.stripe.com/c/pay/${id}`, customer: body.customer, client_reference_id: body.client_reference_id,
        metadata: { shop_id: body["metadata[shop_id]"], checkout_attempt_id: body["metadata[checkout_attempt_id]"], catalog_version: body["metadata[catalog_version]"], plan_key: body["metadata[plan_key]"] } }
    }
    if ((m = /^\/checkout\/sessions\/([^/]+)$/.exec(path)) && method === "GET") {
      const s = this.sessions.get(m[1])
      if (!s) throw new StripeError(404, "No such session", "resource_missing")
      return { id: m[1], object: "checkout.session", livemode: false, mode: "subscription", status: s.status, url: s.status === "open" ? `https://checkout.stripe.com/c/pay/${m[1]}` : null, customer: s.customer,
        client_reference_id: s.attemptId, metadata: { shop_id: s.shopId, checkout_attempt_id: s.attemptId, catalog_version: "2026-11-03.v1", plan_key: "founder-pilot" },
        line_items: this.lineItems(s.items) }
    }
    if ((m = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(path)) && method === "POST") {
      const s = this.sessions.get(m[1])
      if (s) s.status = "expired"
      return { id: m[1], object: "checkout.session", livemode: false, status: "expired" }
    }
    if (method === "POST" && path === "/subscriptions") {
      if (this.options.rejectSubscription) throw new StripeError(400, "rejected", "invalid_request")
      const customer = this.customers.get(String(body.customer))
      if (!customer) throw new StripeError(404, "No such customer", "resource_missing")
      const items: { priceId: string; quantity?: number }[] = []
      for (let i = 0; body[`items[${i}][price]`] !== undefined; i += 1) {
        const quantity = body[`items[${i}][quantity]`]
        items.push({ priceId: String(body[`items[${i}][price]`]), ...(quantity !== undefined ? { quantity: Number(quantity) } : {}) })
      }
      const clock = this.clocks.get(customer.clock)!
      const sub: Sub = { id: this.id("sub"), customer: customer.id, status: "active", start: clock.frozen, periodStart: clock.frozen, periodEnd: addMonth(clock.frozen), items, canceled: false }
      this.subs.set(sub.id, sub)
      return this.subObject(sub)
    }
    if ((m = /^\/subscriptions\/([^/]+)$/.exec(path))) {
      const sub = this.subs.get(m[1])
      if (!sub) throw new StripeError(404, "No such subscription", "resource_missing")
      if (method === "DELETE") {
        sub.status = "canceled"
        sub.canceled = true
      }
      return this.subObject(sub)
    }
    if (method === "GET" && path === "/invoices/create_preview") {
      if (this.options.previewUnsupported) throw new StripeError(404, "Unrecognized request URL", "resource_missing")
      const sub = this.subs.get(String(body.subscription))
      if (!sub) throw new StripeError(404, "No such subscription", "resource_missing")
      const clock = this.clocks.get(this.customers.get(sub.customer)!.clock)!
      return { object: "invoice", livemode: false, total: SANDBOX_BASE_PRICE.unitAmountCents + this.usageCents(sub.customer, sub.periodStart, sub.periodEnd, clock.frozen) }
    }
    if (method === "GET" && path === "/invoices") {
      const customer = String(body.customer)
      return { object: "list", has_more: false, data: [...this.stripeInvoices.values()].filter((i) => i.customer === customer).map((i) => this.invObject(i)) }
    }
    if ((m = /^\/invoices\/([^/]+)\/pay$/.exec(path)) && method === "POST") {
      const inv = this.stripeInvoices.get(m[1])
      if (!inv) throw new StripeError(404, "No such invoice", "resource_missing")
      const pm = this.pms.get(String(body.payment_method))
      if (pm?.kind === "visa") {
        inv.status = "paid"
        const sub = this.subs.get(inv.subscription)!
        if (![...this.stripeInvoices.values()].some((i) => i.subscription === sub.id && i.status === "open")) sub.status = "active"
      } else {
        inv.attemptCount += 1
        throw new StripeError(402, "card declined", "card_declined")
      }
      return this.invObject(inv)
    }
    return undefined
  }
}
