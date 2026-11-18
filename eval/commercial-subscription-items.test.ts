import { describe, expect, it } from "vitest"

import {
  FOUNDER_PILOT_ITEM_SET_DIGEST,
  FOUNDER_PILOT_ITEM_SLOTS,
  buildFounderPilotLineItems,
  evaluateSubscriptionItems,
} from "@/lib/commercial-subscription-items"
import { FOUNDER_PILOT_PRICE } from "@/lib/commercial-billing"
import { SANDBOX_METERS } from "@/lib/stripe-sandbox-contract"
import { exactFixtureItems, fixtureItem } from "./_commercial-item-fixtures"

const slot = (name: string) => FOUNDER_PILOT_ITEM_SLOTS.find((s) => s.slot === name)!
const findings = (items: unknown) => {
  const result = evaluateSubscriptionItems(items)
  return result.ok ? [] : result.findings
}

describe("the exact Founder Pilot item set (contract)", () => {
  it("is the approved licensed base plus exactly the six reviewed metered Prices, by lookup key", () => {
    expect(FOUNDER_PILOT_ITEM_SLOTS).toHaveLength(7)
    expect(FOUNDER_PILOT_ITEM_SLOTS[0]).toMatchObject({ slot: "base", lookupKey: FOUNDER_PILOT_PRICE.lookupKey, usageType: "licensed", unitAmountCents: 19_900 })
    expect(FOUNDER_PILOT_ITEM_SLOTS.slice(1).map((s) => s.lookupKey)).toEqual(SANDBOX_METERS.map((m) => m.meteredPriceLookupKey))
    expect(new Set(FOUNDER_PILOT_ITEM_SLOTS.map((s) => s.lookupKey)).size).toBe(7)
    // No Stripe object id and no secret anywhere in the contract.
    expect(JSON.stringify(FOUNDER_PILOT_ITEM_SLOTS)).not.toMatch(/(price|prod|mtr|cus|sub|si)_[A-Za-z0-9]{6,}/)
    expect(FOUNDER_PILOT_ITEM_SET_DIGEST).toMatch(/^[0-9a-f]{64}$/)
  })

  it("accepts the exact set in any order", () => {
    expect(evaluateSubscriptionItems(exactFixtureItems())).toEqual({ ok: true })
    expect(evaluateSubscriptionItems([...exactFixtureItems()].reverse())).toEqual({ ok: true })
    const rotated = exactFixtureItems()
    rotated.push(rotated.shift()!)
    expect(evaluateSubscriptionItems(rotated)).toEqual({ ok: true })
  })

  it("accepts a product given as an expanded object, and a null quantity on metered items", () => {
    const items = exactFixtureItems().map((item) => ({ ...item, price: { ...item.price, product: { id: "prod_FakeFounderPilot", object: "product" } } }))
    items[1] = { ...items[1], quantity: null } as never
    expect(evaluateSubscriptionItems(items)).toEqual({ ok: true })
  })

  it.each([
    ["not an array", undefined, ["items_unreadable"]],
    ["empty", [], ["item_count_mismatch", "item_missing"]],
    ["only the base item (the PR C/E1 shape)", exactFixtureItems().slice(0, 1), ["item_count_mismatch", "item_missing"]],
    ["one metered item missing", exactFixtureItems().slice(0, 6), ["item_count_mismatch", "item_missing"]],
    ["an extra seat-price item", [...exactFixtureItems(), { quantity: 1, price: { lookup_key: "gradia_operator_seat_2026_11_monthly" } }], ["item_count_mismatch", "item_unknown_price"]],
    ["a duplicate metered item replacing another", [...exactFixtureItems().slice(0, 6), exactFixtureItems()[1]], ["item_duplicate", "item_missing"]],
    ["a duplicate base item (8 items)", [...exactFixtureItems(), exactFixtureItems()[0]], ["item_count_mismatch", "item_duplicate"]],
    ["an unknown price instead of a metered one", [...exactFixtureItems().slice(0, 6), { quantity: 1, price: { lookup_key: "something_else" } }], ["item_unknown_price", "item_missing"]],
    ["a price with no lookup key", [...exactFixtureItems().slice(0, 6), { price: { lookup_key: null } }], ["item_unknown_price", "item_missing"]],
    ["a null item", [...exactFixtureItems().slice(0, 6), null], ["item_unreadable", "item_missing"]],
  ])("refuses %s", (_name, items, expected) => {
    expect(findings(items)).toEqual(expected)
  })

  const replaceSlot = (name: string, patch: Parameters<typeof fixtureItem>[1]) =>
    exactFixtureItems().map((item) => (item.price.lookup_key === slot(name).lookupKey ? fixtureItem(slot(name), patch) : item))

  it.each([
    ["a wrong licensed quantity", replaceSlot("base", { item: { quantity: 2 } }), ["item_quantity_mismatch"]],
    ["a missing licensed quantity", replaceSlot("base", { item: { quantity: undefined } }), ["item_quantity_mismatch"]],
    ["a metered item carrying a quantity", replaceSlot("qualified_lead", { item: { quantity: 1 } }), ["item_quantity_mismatch"]],
    ["a wrong base amount", replaceSlot("base", { price: { unit_amount: 2_000 } }), ["item_price_mismatch"]],
    ["a wrong metered amount", replaceSlot("qualified_lead", { price: { unit_amount: 7 } }), ["item_price_mismatch"]],
    ["the wrong currency", replaceSlot("sms_segment", { price: { currency: "eur" } }), ["item_price_mismatch"]],
    ["a yearly interval", replaceSlot("base", { recurring: { interval: "year" } }), ["item_price_mismatch"]],
    ["interval_count 3", replaceSlot("confirmed_appointment", { recurring: { interval_count: 3 } }), ["item_price_mismatch"]],
    ["a licensed price where metered is required", replaceSlot("sms_segment", { recurring: { usage_type: "licensed" } }), ["item_price_mismatch"]],
    ["a metered price where licensed is required", replaceSlot("base", { recurring: { usage_type: "metered" } }), ["item_price_mismatch"]],
    ["a tiered billing scheme", replaceSlot("base", { price: { billing_scheme: "tiered" } }), ["item_price_mismatch"]],
    ["a one-time price", replaceSlot("base", { price: { type: "one_time" } }), ["item_price_mismatch"]],
    ["a live-mode price", replaceSlot("qualified_lead", { price: { livemode: true } }), ["item_live"]],
    ["a price missing its livemode flag", replaceSlot("qualified_lead", { price: { livemode: undefined } }), ["item_live"]],
    ["a metered price with no meter", replaceSlot("qualified_lead", { recurring: { meter: undefined } }), ["item_meter_missing"]],
    ["items on different products", replaceSlot("sms_segment", { price: { product: "prod_SomeOtherProduct" } }), ["item_product_mismatch"]],
    ["an item with no product", replaceSlot("sms_segment", { price: { product: null } }), ["item_product_mismatch"]],
  ])("refuses %s", (_name, items, expected) => {
    expect(findings(items)).toEqual(expected)
  })

  it("never reads metadata (an exact set is exact whatever the metadata says)", () => {
    const items = exactFixtureItems().map((item) => ({ ...item, metadata: { shop_id: "other", lookup_key: "gradia_founder_pilot_2026_11_monthly" } }))
    expect(evaluateSubscriptionItems(items)).toEqual({ ok: true })
    const bad = exactFixtureItems().slice(0, 6).map((item) => ({ ...item, metadata: { lookup_key: FOUNDER_PILOT_PRICE.lookupKey } }))
    expect(evaluateSubscriptionItems(bad).ok).toBe(false)
  })

  it("builds Checkout line items: base x1 first, then six metered with no quantity, deterministic", () => {
    const prices = {
      base: "price_b",
      metered: Object.fromEntries(SANDBOX_METERS.map((m) => [m.component, `price_${m.component}`])),
    }
    const items = buildFounderPilotLineItems(prices)!
    expect(items).toHaveLength(7)
    expect(items[0]).toEqual({ priceId: "price_b", quantity: 1 })
    expect(items.slice(1).every((i) => i.quantity === undefined)).toBe(true)
    expect(buildFounderPilotLineItems(prices)).toEqual(items)
    expect(buildFounderPilotLineItems({ base: "price_b", metered: { ...prices.metered, sms_segment: undefined } })).toBeNull()
    expect(buildFounderPilotLineItems({ base: "price_dup", metered: { ...prices.metered, sms_segment: "price_dup" } })).toBeNull()
  })
})
