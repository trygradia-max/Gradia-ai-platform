import { FOUNDER_PILOT_ITEM_SLOTS, type ItemSlot } from "@/lib/commercial-subscription-items"

/**
 * Test fixtures for the exact Founder Pilot item set (PR F2). Provider-shaped subscription items / Checkout
 * line items built from the committed contract; no real Stripe ids.
 */
export const FIXTURE_PRODUCT_ID = "prod_FakeFounderPilot"

export function fixtureItem(slot: ItemSlot, patch: { item?: Record<string, unknown>; price?: Record<string, unknown>; recurring?: Record<string, unknown> } = {}) {
  const metered = slot.usageType === "metered"
  return {
    id: `si_Fake_${slot.slot}`,
    object: "subscription_item",
    ...(metered ? {} : { quantity: 1 }),
    price: {
      id: `price_Fake_${slot.slot}`,
      object: "price",
      active: true,
      livemode: false,
      currency: "usd",
      lookup_key: slot.lookupKey,
      type: "recurring",
      billing_scheme: "per_unit",
      unit_amount: slot.unitAmountCents,
      product: FIXTURE_PRODUCT_ID,
      recurring: { interval: "month", interval_count: 1, usage_type: slot.usageType, ...(metered ? { meter: `mtr_test_Fake_${slot.slot}` } : {}), ...patch.recurring },
      ...patch.price,
    },
    ...patch.item,
  }
}

export const exactFixtureItems = () => FOUNDER_PILOT_ITEM_SLOTS.map((slot) => fixtureItem(slot))
export const subscriptionItems = (items: unknown[] = exactFixtureItems()) => ({ data: items })
