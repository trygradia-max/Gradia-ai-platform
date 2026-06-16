import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  composeReceiptSms,
  computeRoiReceipt,
  formatReceiptDollars,
  formatReceiptHours,
  SAVED_MINUTES,
} from "@/lib/data/roi-receipt"

/**
 * The ROI receipt is a trust artifact (FOCUS spec NOW-3): every number must
 * trace to real rows and under-claim. These pure tests lock that — money only
 * counts bookings whose service name matches a real price, and an empty week
 * never produces a push.
 */

type TableResult = { count?: number; data?: unknown[] }

/** Minimal Supabase double: each table resolves to a preset count/data. The
 *  chain methods (select/eq/in/gte/lt) are no-ops that return the thenable. */
function makeReceiptMock(results: Record<string, TableResult>): SupabaseClient {
  function chainFor(table: string): unknown {
    const result = results[table] ?? { count: 0, data: [] }
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (res: (v: unknown) => unknown) =>
            Promise.resolve({
              data: result.data ?? [],
              count: result.count ?? 0,
              error: null,
            }).then(res)
        return () => proxy
      },
    })
    return proxy
  }
  return { from: (table: string) => chainFor(table) } as unknown as SupabaseClient
}

const START = new Date("2026-06-08T00:00:00Z")
const END = new Date("2026-06-15T00:00:00Z")

describe("ROI receipt — honest compute", () => {
  it("counts each metric from its own table and saves time conservatively", async () => {
    const supabase = makeReceiptMock({
      leads: { count: 3 },
      pending_actions: { count: 4 },
      appointments: {
        data: [{ service_name: "Full Detail" }, { service_name: "Ceramic Coating" }],
      },
      services: {
        data: [
          { name: "Full Detail", price_cents: 25000 },
          { name: "Ceramic Coating", price_cents: 90000 },
        ],
      },
    })

    const r = await computeRoiReceipt(supabase, "shop_1", START, END)

    expect(r.leadsCaught).toBe(3)
    expect(r.messagesSent).toBe(4)
    expect(r.bookingsMade).toBe(2)
    expect(r.moneyInPlayCents).toBe(115000) // 250 + 900
    expect(r.minutesSaved).toBe(
      3 * SAVED_MINUTES.lead + 4 * SAVED_MINUTES.message + 2 * SAVED_MINUTES.booking
    )
    expect(r.isEmpty).toBe(false)
  })

  it("never invents a dollar: a booking with no matching service contributes $0", async () => {
    const supabase = makeReceiptMock({
      leads: { count: 0 },
      pending_actions: { count: 0 },
      appointments: {
        data: [
          { service_name: "Full Detail" }, // matches
          { service_name: "Mystery Package" }, // no matching price → $0
          { service_name: null }, // unnamed → $0
        ],
      },
      services: { data: [{ name: "Full Detail", price_cents: 25000 }] },
    })

    const r = await computeRoiReceipt(supabase, "shop_1", START, END)

    expect(r.bookingsMade).toBe(3)
    expect(r.moneyInPlayCents).toBe(25000) // only the one we can prove
  })

  it("matches service names case/space-insensitively", async () => {
    const supabase = makeReceiptMock({
      appointments: { data: [{ service_name: "  full DETAIL " }] },
      services: { data: [{ name: "Full Detail", price_cents: 25000 }] },
    })
    const r = await computeRoiReceipt(supabase, "shop_1", START, END)
    expect(r.moneyInPlayCents).toBe(25000)
  })

  it("reports an empty week when nothing happened", async () => {
    const supabase = makeReceiptMock({})
    const r = await computeRoiReceipt(supabase, "shop_1", START, END)
    expect(r.isEmpty).toBe(true)
    expect(r.moneyInPlayCents).toBe(0)
  })
})

describe("ROI receipt — weekly SMS push copy", () => {
  const base = {
    periodStart: START.toISOString(),
    periodEnd: END.toISOString(),
    leadsCaught: 3,
    messagesSent: 4,
    bookingsMade: 2,
    moneyInPlayCents: 115000,
    minutesSaved: 38,
    isEmpty: false,
  }

  it("never texts an empty week", () => {
    expect(composeReceiptSms("Pristine Detailing", { ...base, isEmpty: true })).toBeNull()
  })

  it("writes a we/us, signed digest with the money figure", () => {
    const sms = composeReceiptSms("Pristine Detailing", base)
    expect(sms).toBeTruthy()
    expect(sms).toContain("we got")
    expect(sms).toContain("3 leads caught")
    expect(sms).toContain("$1,150")
    expect(sms).toContain("— Gradia at Pristine Detailing")
    // Honest framing — "in play" pipeline, never a claim of earned revenue.
    expect(sms).not.toMatch(/earned|profit|made \$/i)
  })

  it("omits the money line when nothing is traceable", () => {
    const sms = composeReceiptSms("Pristine Detailing", {
      ...base,
      moneyInPlayCents: 0,
    })
    expect(sms).toBeTruthy()
    expect(sms).not.toContain("$")
  })

  it("singularizes counts of one", () => {
    const sms = composeReceiptSms("Pristine Detailing", {
      ...base,
      leadsCaught: 1,
      messagesSent: 1,
      bookingsMade: 1,
    })
    expect(sms).toContain("1 lead caught")
    expect(sms).toContain("1 reply sent for you")
    expect(sms).toContain("1 booking secured")
  })
})

describe("ROI receipt — formatters", () => {
  it("drops cents when the dollar amount is whole", () => {
    expect(formatReceiptDollars(115000)).toBe("$1,150")
    expect(formatReceiptDollars(2599)).toBe("$25.99")
  })

  it('renders hours as a conservative "~" estimate', () => {
    expect(formatReceiptHours(38)).toBe("~38 min")
    expect(formatReceiptHours(60)).toBe("~1 hrs")
    expect(formatReceiptHours(150)).toBe("~2.5 hrs")
  })
})
