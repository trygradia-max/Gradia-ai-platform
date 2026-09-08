import { describe, it, expect } from "vitest"

import {
  applyConditionMultipliers,
  describeDuration,
  describePrice,
  durationSpread,
  formatPriceUsd,
  priceSpread,
  resolveDurationMinutes,
  resolvePriceCents,
} from "@/lib/service-pricing"
import { synthesizeSystemPrompt } from "@/lib/vapi-prompt"
import type { ServiceRow } from "@/lib/types/database"

/**
 * Tier 1 — pure. Locks the C1 pricing-resolution rule (spec §C1.6):
 * size-class price if present, else price_cents. The jsonb maps are
 * owner-edited config, so malformed values must fall back, never throw.
 * Also locks that the voice prompt (persona composition) reads through
 * the same module — voice quotes and CRM quotes can never disagree.
 */

// --- config fixtures -------------------------------------------------------

/** Flat pricing only — the pre-C1 shape every existing shop has. */
const FLAT = { price_cents: 15000, duration_minutes: 90 }

/** Full size-class menu (an owner who priced every class). */
const SIZED = {
  price_cents: 15000,
  duration_minutes: 90,
  base_price_by_size: {
    sedan: 15000,
    coupe: 14000,
    truck_suv: 22000,
    xl_van: 28000,
  },
  duration_by_size: { sedan: 90, truck_suv: 150 },
}

/** Partial menu — only some classes priced (the common real case). */
const PARTIAL = {
  price_cents: 9900,
  duration_minutes: 60,
  base_price_by_size: { truck_suv: 14900 },
}

/** Owner-edited jsonb gone wrong: strings, negatives, junk keys, nulls. */
const MALFORMED = {
  price_cents: 12000,
  duration_minutes: 75,
  base_price_by_size: {
    sedan: "150.00", // dollars-as-string is NOT cents — but numeric strings parse
    truck_suv: -5, // negative → invalid
    xl_van: null, // null → invalid
    exotic: "call us", // NaN → invalid
    not_a_size: 99999, // unknown key → ignored
  },
} as unknown as Pick<
  ServiceRow,
  "price_cents" | "duration_minutes" | "base_price_by_size"
>

const WITH_MULTIPLIERS = {
  price_cents: 20000,
  duration_minutes: 120,
  condition_multipliers: [
    { key: "heavy_soil", label: "Heavy soiling", multiplier: 1.25 },
    { key: "pet_hair", label: "Pet hair", multiplier: 1.15 },
    { key: "broken", multiplier: -2 }, // invalid → skipped
  ],
} as unknown as Pick<
  ServiceRow,
  "price_cents" | "duration_minutes" | "condition_multipliers"
>

// --- resolution rule -------------------------------------------------------

describe("resolvePriceCents — size-class price, else price_cents (locked)", () => {
  it("returns the size-class price when the map has the class", () => {
    expect(resolvePriceCents(SIZED, "truck_suv")).toBe(22000)
    expect(resolvePriceCents(SIZED, "sedan")).toBe(15000)
  })

  it("falls back to price_cents when the class is missing from the map", () => {
    expect(resolvePriceCents(PARTIAL, "sedan")).toBe(9900)
    expect(resolvePriceCents(PARTIAL, "truck_suv")).toBe(14900)
  })

  it("falls back to price_cents with no size class or no map", () => {
    expect(resolvePriceCents(SIZED)).toBe(15000)
    expect(resolvePriceCents(SIZED, null)).toBe(15000)
    expect(resolvePriceCents(FLAT, "truck_suv")).toBe(15000)
  })

  it("treats malformed map values as absent — never throws, never charges junk", () => {
    expect(resolvePriceCents(MALFORMED, "truck_suv")).toBe(12000) // negative
    expect(resolvePriceCents(MALFORMED, "xl_van")).toBe(12000) // null
    expect(resolvePriceCents(MALFORMED, "exotic")).toBe(12000) // NaN
    // Numeric strings are tolerated (owner typed into a text input).
    expect(resolvePriceCents(MALFORMED, "sedan")).toBe(150)
  })

  it("survives a map that isn't an object at all", () => {
    const broken = {
      price_cents: 5000,
      base_price_by_size: [1, 2, 3],
    } as unknown as typeof FLAT
    expect(resolvePriceCents(broken, "sedan")).toBe(5000)
  })
})

describe("resolveDurationMinutes — same rule, duration_minutes fallback", () => {
  it("resolves by size and falls back", () => {
    expect(resolveDurationMinutes(SIZED, "truck_suv")).toBe(150)
    expect(resolveDurationMinutes(SIZED, "coupe")).toBe(90)
    expect(resolveDurationMinutes(FLAT, "truck_suv")).toBe(90)
  })
})

// --- spread + display ------------------------------------------------------

describe("priceSpread", () => {
  it("is null for flat pricing and min/max for sized pricing", () => {
    expect(priceSpread(FLAT)).toBeNull()
    expect(priceSpread(SIZED)).toEqual({ low: 14000, high: 28000 })
    expect(priceSpread(PARTIAL)).toEqual({ low: 14900, high: 14900 })
  })
})

describe("describePrice", () => {
  it("gives an exact price when the size class resolves", () => {
    expect(describePrice(SIZED, "truck_suv")).toBe("$220")
  })

  it("gives the spread when sized but the vehicle is unknown", () => {
    expect(describePrice(SIZED)).toBe(
      "$140 to $280 depending on vehicle size"
    )
  })

  it("gives the flat price for flat services", () => {
    expect(describePrice(FLAT)).toBe("$150")
  })

  it("collapses a single-class map to its one price", () => {
    expect(describePrice(PARTIAL)).toBe("$149")
  })
})

describe("formatPriceUsd", () => {
  it("drops cents when whole, keeps them when not", () => {
    expect(formatPriceUsd(15000)).toBe("$150")
    expect(formatPriceUsd(14950)).toBe("$149.50")
  })
})

// --- condition multipliers --------------------------------------------------

describe("applyConditionMultipliers", () => {
  it("applies selected multipliers and rounds once at the end", () => {
    expect(applyConditionMultipliers(20000, WITH_MULTIPLIERS, ["heavy_soil"])).toBe(
      25000
    )
    // 20000 * 1.25 * 1.15 = 28750
    expect(
      applyConditionMultipliers(20000, WITH_MULTIPLIERS, [
        "heavy_soil",
        "pet_hair",
      ])
    ).toBe(28750)
  })

  it("skips unknown keys and invalid multipliers", () => {
    expect(
      applyConditionMultipliers(20000, WITH_MULTIPLIERS, ["nope", "broken"])
    ).toBe(20000)
    expect(applyConditionMultipliers(20000, FLAT, ["heavy_soil"])).toBe(20000)
  })
})

// --- the shared-module guarantee -------------------------------------------

describe("voice prompt reads through the shared module", () => {
  const service = (over: Partial<ServiceRow>): ServiceRow =>
    ({
      id: "svc-1",
      shop_id: "shop-1",
      name: "Full Detail",
      description: null,
      price_cents: 15000,
      duration_minutes: 90,
      category: null,
      base_price_by_size: null,
      duration_by_size: null,
      condition_multipliers: null,
      is_addon: false,
      addon_eligible: true,
      mobile_eligible: true,
      active: true,
      created_at: "",
      updated_at: "",
      ...over,
    }) as ServiceRow

  it("menu lines carry the exact resolved price for flat services", () => {
    const prompt = synthesizeSystemPrompt({
      shop: { name: "Shine Co", location: null, phone: null },
      services: [service({})],
      knowledge: [],
    })
    expect(prompt).toContain(`- Full Detail: ${describePrice(service({}))}, `)
    expect(prompt).toContain("$150")
  })

  it("menu lines carry the size-class spread and add the size guidance", () => {
    const sized = service({
      base_price_by_size: { sedan: 15000, truck_suv: 22000 },
    })
    const prompt = synthesizeSystemPrompt({
      shop: { name: "Shine Co", location: null, phone: null },
      services: [sized],
      knowledge: [],
    })
    expect(prompt).toContain("$150 to $220 depending on vehicle size")
    expect(prompt).toContain("priced or timed by vehicle size")
    // The numbers in the prompt are exactly the module's resolution.
    expect(describePrice(sized)).toBe("$150 to $220 depending on vehicle size")
    expect(resolvePriceCents(sized, "truck_suv")).toBe(22000)
  })

  it("flat menus don't get the size guidance line", () => {
    const prompt = synthesizeSystemPrompt({
      shop: { name: "Shine Co", location: null, phone: null },
      services: [service({})],
      knowledge: [],
    })
    expect(prompt).not.toContain("priced by vehicle size")
  })
})

// --- duration: the same rule money already had ------------------------------
/**
 * Regression guard for the B-16 follow-up: onboarding collects per-size
 * durations, and `resolveDurationMinutes(service)` with NO size class
 * silently returns the flat `duration_minutes`. Every voice and drafting
 * surface called it that way, so a shop configured "sedan 90, truck 150"
 * told a truck owner 90. Price never had this bug because `describePrice`
 * already fell back to a spread — duration now does too.
 */
describe("durationSpread / describeDuration", () => {
  it("flat durations have no spread and read as one number", () => {
    expect(durationSpread(FLAT)).toBeNull()
    expect(describeDuration(FLAT)).toBe("90 min")
  })

  it("varying size durations read as a range when the vehicle is unknown", () => {
    expect(durationSpread(SIZED)).toEqual({ low: 90, high: 150 })
    expect(describeDuration(SIZED)).toBe(
      "90–150 min depending on vehicle size"
    )
  })

  it("a known size class resolves to that exact duration", () => {
    expect(describeDuration(SIZED, "truck_suv")).toBe("150 min")
    expect(describeDuration(SIZED, "sedan")).toBe("90 min")
  })

  it("a size class the owner never configured falls back to the range", () => {
    // rv is absent from duration_by_size — do not invent a number for it.
    expect(describeDuration(SIZED, "rv")).toBe(
      "90–150 min depending on vehicle size"
    )
  })

  it("a single configured size reads as that number, not a range", () => {
    const one = { duration_minutes: 60, duration_by_size: { truck_suv: 120 } }
    expect(durationSpread(one)).toEqual({ low: 120, high: 120 })
    expect(describeDuration(one)).toBe("120 min")
  })

  it("malformed owner jsonb falls back instead of throwing", () => {
    const junk = {
      duration_minutes: 75,
      duration_by_size: {
        sedan: -5,
        truck_suv: null,
        exotic: "a while",
        not_a_size: 999,
      },
    } as unknown as Parameters<typeof describeDuration>[0]
    expect(durationSpread(junk)).toBeNull()
    expect(describeDuration(junk)).toBe("75 min")
  })

  it("the voice prompt states a duration range, never the flat number", () => {
    const sized: ServiceRow = {
      id: "svc-1",
      shop_id: "shop-1",
      name: "Full Detail",
      description: null,
      price_cents: 15000,
      duration_minutes: 90,
      category: null,
      base_price_by_size: null,
      duration_by_size: { sedan: 90, truck_suv: 150 },
      condition_multipliers: null,
      is_addon: false,
      addon_eligible: true,
      mobile_eligible: true,
      active: true,
      created_at: "",
      updated_at: "",
    }
    const prompt = synthesizeSystemPrompt({
      shop: { name: "Shine Co", location: null, phone: null },
      services: [sized],
      knowledge: [],
    })
    expect(prompt).toContain("about 1.5 hours to about 2.5 hours depending on size")
    expect(prompt).toContain("priced or timed by vehicle size")
  })
})
