import { describe, it, expect } from "vitest"

import {
  buildQuoteLineItem,
  computeQuoteTotals,
  quoteEmailBody,
  quotePath,
  quoteSmsBody,
} from "@/lib/quotes"
import { describePrice, resolvePriceCents } from "@/lib/service-pricing"

/**
 * C3b — quote math locks. Line items resolve through the SAME module the
 * voice receptionist quotes from (spec acceptance: "voice agent quotes and
 * CRM quote builder produce identical prices for the same service+size").
 */

const SIZED_SERVICE = {
  id: "svc-1",
  name: "Ceramic Coating",
  price_cents: 99900,
  duration_minutes: 480,
  base_price_by_size: { sedan: 99900, truck_suv: 119900 },
  condition_multipliers: [
    { key: "heavy_soil", label: "Heavy soiling", multiplier: 1.2 },
  ],
}

describe("buildQuoteLineItem — identical numbers to the voice path", () => {
  it("resolves the size-class price the receptionist would speak", () => {
    const li = buildQuoteLineItem(SIZED_SERVICE, "truck_suv")
    expect(li.base_cents).toBe(119900)
    expect(li.price_cents).toBe(119900)
    // The exact same module call the voice prompt/tools make:
    expect(li.base_cents).toBe(resolvePriceCents(SIZED_SERVICE, "truck_suv"))
    expect(describePrice(SIZED_SERVICE, "truck_suv")).toBe("$1199")
  })

  it("falls back to price_cents when the vehicle size is unknown", () => {
    const li = buildQuoteLineItem(SIZED_SERVICE, null)
    expect(li.base_cents).toBe(99900)
  })

  it("applies condition multipliers on top and records them as modifiers", () => {
    const li = buildQuoteLineItem(SIZED_SERVICE, "truck_suv", ["heavy_soil"])
    expect(li.price_cents).toBe(143880) // 119900 × 1.2
    expect(li.modifiers).toEqual(["heavy_soil"])
    expect(li.base_cents).toBe(119900) // base stays auditable
  })
})

describe("computeQuoteTotals", () => {
  const items = [
    buildQuoteLineItem(SIZED_SERVICE, "sedan"),
    buildQuoteLineItem(
      { id: "svc-2", name: "Engine Bay", price_cents: 7900 },
      "sedan"
    ),
  ]

  it("sums line items and clamps the discount", () => {
    expect(computeQuoteTotals(items)).toEqual({
      subtotal_cents: 107800,
      discount_cents: 0,
      total_cents: 107800,
    })
    expect(computeQuoteTotals(items, 10000).total_cents).toBe(97800)
    // Discount can never push a total negative.
    expect(computeQuoteTotals(items, 999999).total_cents).toBe(0)
  })
})

describe("outbound quote copy", () => {
  it("SMS body carries the total and the public link, nothing else fancy", () => {
    const body = quoteSmsBody({
      shopName: "Shine Co",
      customerName: "Ada Lovelace",
      totalCents: 119900,
      url: "https://app.example/q/abc123",
    })
    expect(body).toContain("Hi Ada")
    expect(body).toContain("$1199")
    expect(body).toContain("https://app.example/q/abc123")
  })

  it("email fallback carries validity when present", () => {
    const email = quoteEmailBody({
      shopName: "Shine Co",
      customerName: null,
      totalCents: 50000,
      url: "https://app.example/q/abc123",
      validUntil: "2026-07-23",
    })
    expect(email.subject).toContain("$500")
    expect(email.body).toContain("2026-07-23")
  })

  it("quotePath shapes the public URL", () => {
    expect(quotePath("tok123")).toBe("/q/tok123")
  })
})
