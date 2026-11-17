import { describe, expect, it } from "vitest"

import { createAdjustmentProvider, verifyInvoiceItemAck } from "@/lib/commercial-adjustment-provider"
import { createMeterEvidenceReader, createSettlementProvider } from "@/lib/commercial-settlement-provider"
import { verifyMeterAck } from "@/lib/commercial-settlement"
import { minuteStartSeconds } from "@/lib/commercial-billing-operations"
import { COMMERCIAL_METER_API_VERSION, SANDBOX_METERS } from "@/lib/stripe-sandbox-contract"
import { FakeStripeSandbox } from "./_fake-stripe-sandbox"

const config = { secretKey: "sk_test_FAKEFAKEFAKEFAKE0123", apiBase: "https://api.stripe.com/v1", timeoutMs: 5_000 }
const CLOCK = Date.UTC(2026, 8, 1, 0, 30) / 1000
const meter = SANDBOX_METERS[0]
const ID = "gradia-cb-settle-" + "a".repeat(40)
const event = { eventName: meter.eventName, customerId: "cus_FakeCustomer1", value: "7", identifier: ID, timestampSeconds: CLOCK - 1800 - 1 }

describe("meter event send (reviewed API version)", () => {
  it("sends the reviewed version, the identifier as the idempotency key, and gets an exact acknowledgement", async () => {
    const fake = FakeStripeSandbox.provisioned(CLOCK)
    const ack = await createSettlementProvider(config, fake.request).submitMeterEvent(event)
    expect(fake.calls).toEqual([{ method: "POST", path: "/billing/meter_events", apiVersion: COMMERCIAL_METER_API_VERSION, idempotencyKey: ID }])
    expect(verifyMeterAck(ack, { eventName: event.eventName, customerId: event.customerId, value: "7", identifier: ID })).toEqual({ ok: true })
  })
  it("a repeated identifier never counts twice", async () => {
    const fake = FakeStripeSandbox.provisioned(CLOCK)
    const provider = createSettlementProvider(config, fake.request)
    await provider.submitMeterEvent(event)
    await provider.submitMeterEvent(event)
    expect(fake.events.size).toBe(1)
    expect(fake.duplicateMeterEventAttempts).toBe(1)
  })
})

describe("meter evidence reader (read only)", () => {
  const start = minuteStartSeconds(new Date(event.timestampSeconds * 1000).toISOString())
  it("reports the observed total for the customer's minute and sends only GETs", async () => {
    const fake = FakeStripeSandbox.provisioned(CLOCK)
    await createSettlementProvider(config, fake.request).submitMeterEvent(event)
    fake.calls.length = 0
    const total = await createMeterEvidenceReader(config, fake.request).readObservedTotal({ eventName: meter.eventName, customerId: event.customerId, startSeconds: start })
    expect(total).toBe(7)
    expect(fake.calls.every((c) => c.method === "GET" && c.apiVersion === COMMERCIAL_METER_API_VERSION)).toBe(true)
  })
  it("reports 0 when nothing was recorded, and another customer's usage is invisible", async () => {
    const fake = FakeStripeSandbox.provisioned(CLOCK)
    await createSettlementProvider(config, fake.request).submitMeterEvent({ ...event, customerId: "cus_OtherCustomer" })
    expect(await createMeterEvidenceReader(config, fake.request).readObservedTotal({ eventName: meter.eventName, customerId: event.customerId, startSeconds: start })).toBe(0)
  })
  it("refuses an unaligned window, an unresolved or duplicate meter and an unreadable summary instead of guessing", async () => {
    const fake = FakeStripeSandbox.provisioned(CLOCK)
    const reader = createMeterEvidenceReader(config, fake.request)
    await expect(reader.readObservedTotal({ eventName: meter.eventName, customerId: event.customerId, startSeconds: start + 1 })).rejects.toThrow("window_not_minute_aligned")
    await expect(reader.readObservedTotal({ eventName: "no_such_meter", customerId: event.customerId, startSeconds: start })).rejects.toThrow("meter_unresolved")
    fake.meters.push({ ...fake.meters[0], id: "mtr_test_dup" })
    await expect(reader.readObservedTotal({ eventName: meter.eventName, customerId: event.customerId, startSeconds: start })).rejects.toThrow("meter_unresolved")
  })
})

describe("pending invoice item (approved adjustments only reach here)", () => {
  const item = { customerId: "cus_FakeCustomer1", signedAmountCents: -1250, identifier: "gradia-cb-adjust-" + "b".repeat(40) }
  it("creates exactly one pending signed item, idempotently, with no refund or credit-note call", async () => {
    const fake = FakeStripeSandbox.provisioned(CLOCK)
    const provider = createAdjustmentProvider(config, fake.request)
    const ack = await provider.createPendingInvoiceItem(item)
    await provider.createPendingInvoiceItem(item)
    expect(fake.items.size).toBe(1)
    expect(verifyInvoiceItemAck(ack, item)).toEqual({ ok: true })
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /invoiceitems", "POST /invoiceitems"])
  })
  it("accepts only the exact pending item", () => {
    const good = { object: "invoiceitem", livemode: false, customer: item.customerId, amount: -1250, currency: "usd", invoice: null }
    expect(verifyInvoiceItemAck(good, item)).toEqual({ ok: true })
    expect(verifyInvoiceItemAck({ ...good, livemode: true }, item)).toEqual({ ok: false, code: "live_object_refused" })
    expect(verifyInvoiceItemAck({ ...good, amount: 1250 }, item)).toEqual({ ok: false, code: "response_mismatch" })
    expect(verifyInvoiceItemAck({ ...good, customer: "cus_Other" }, item)).toEqual({ ok: false, code: "response_mismatch" })
    expect(verifyInvoiceItemAck({ ...good, currency: "eur" }, item)).toEqual({ ok: false, code: "response_mismatch" })
    expect(verifyInvoiceItemAck({ ...good, invoice: "in_123" }, item)).toEqual({ ok: false, code: "attached_to_invoice" })
    expect(verifyInvoiceItemAck({ object: "refund" }, item)).toEqual({ ok: false, code: "unreadable_response" })
    expect(verifyInvoiceItemAck(null, item)).toEqual({ ok: false, code: "unreadable_response" })
  })
})
