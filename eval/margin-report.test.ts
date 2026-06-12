import { describe, it, expect } from "vitest"

import { computeMarginReport, type MarginRow } from "@/lib/margin-report"

/**
 * Tier 1 — pure, deterministic. The margin report is the pricing doc's
 * verification mechanism (rule #3): every metered row carries wholesale +
 * retail, so the ~70% usage margin must be checkable straight off the
 * ledger. These pin the aggregation: per-shop, per-kind, legacy rows
 * surfaced as unpriced rather than silently counted as free COGS.
 */

const names = new Map([
  ["shop-a", "Pristine Detailing"],
  ["shop-b", "Elite Automotive"],
])

const rows: MarginRow[] = [
  // shop-a: 100 SMS segments at locked pricing (wholesale 1.2¢, retail 4¢)
  { shop_id: "shop-a", kind: "sms_segment", quantity: 100, wholesale_cost: 120, retail_cost: 400 },
  // shop-a: 60 voice minutes (wholesale 12¢, retail 25¢)
  { shop_id: "shop-a", kind: "voice_minute", quantity: 60, wholesale_cost: 720, retail_cost: 1500 },
  // shop-a: a legacy row from before the margin columns
  { shop_id: "shop-a", kind: "message", quantity: 1, wholesale_cost: null, retail_cost: null },
  // shop-b: one number rental
  { shop_id: "shop-b", kind: "number_monthly", quantity: 1, wholesale_cost: 115, retail_cost: 250 },
]

describe("computeMarginReport", () => {
  const report = computeMarginReport(rows, names, "2026-06-01T00:00:00Z")

  it("aggregates per shop with margin computable per kind", () => {
    const shopA = report.shops.find((s) => s.shopId === "shop-a")
    expect(shopA).toBeDefined()
    expect(shopA?.wholesaleCents).toBe(840)
    expect(shopA?.retailCents).toBe(1900)
    expect(shopA?.marginCents).toBe(1060)
    expect(shopA?.marginPct).toBeCloseTo(55.8, 1)

    const sms = shopA?.byKind.find((k) => k.kind === "sms_segment")
    expect(sms?.marginPct).toBeCloseTo(70, 0) // the locked ~70% usage margin
    expect(sms?.quantity).toBe(100)
  })

  it("legacy rows count as unpriced, never as free COGS", () => {
    const shopA = report.shops.find((s) => s.shopId === "shop-a")
    expect(shopA?.unpricedEvents).toBe(1)
    // and they don't distort totals
    expect(report.totals.wholesaleCents).toBe(955)
    expect(report.totals.retailCents).toBe(2150)
  })

  it("resolves shop names and sorts by revenue", () => {
    expect(report.shops[0].shopName).toBe("Pristine Detailing")
    expect(report.shops[1].shopName).toBe("Elite Automotive")
  })

  it("empty ledger → empty report, margin null (not 100%)", () => {
    const empty = computeMarginReport([], names, "2026-06-01T00:00:00Z")
    expect(empty.shops).toHaveLength(0)
    expect(empty.totals.marginPct).toBeNull()
  })

  it("a shop with only unpriced rows reports null margin, not free money", () => {
    const r = computeMarginReport(
      [{ shop_id: "shop-a", kind: "agent_run", quantity: 1, wholesale_cost: null, retail_cost: null }],
      names,
      "2026-06-01T00:00:00Z"
    )
    expect(r.shops[0].marginPct).toBeNull()
    expect(r.shops[0].unpricedEvents).toBe(1)
  })
})
