import { describe, it, expect } from "vitest"

import {
  buildServicePatches,
  DETAILER_TEMPLATE_MENU,
  multiplierKey,
  type ServiceMenuInput,
} from "@/lib/service-menu"
import {
  applyConditionMultipliers,
  describePrice,
  resolveDurationMinutes,
  resolvePriceCents,
  VEHICLE_SIZE_CLASSES,
} from "@/lib/service-pricing"
import type { ServiceRow } from "@/lib/types/database"

/**
 * C3a — the menu editor's pure layer, fixture-driven against the LOCKED
 * pricing-resolution rule: a menu edit must change resolvePrice output for
 * every quote surface at once. Config change ≠ test change: the fixtures
 * live here, the rule lives in service-pricing.
 */

/** Apply editor patches to a service row the way the action does. */
function applied(input: ServiceMenuInput): ServiceRow {
  const patches = buildServicePatches(input)
  return {
    id: "svc",
    shop_id: "shop",
    created_at: "",
    updated_at: "",
    ...(patches.core as object),
    ...(patches.extended as object),
  } as ServiceRow
}

describe("menu edits drive resolvePrice output", () => {
  const base: ServiceMenuInput = {
    name: "Full Detail",
    priceDollars: 299,
    durationMinutes: 240,
  }

  it("a flat edit changes the fallback price everywhere", () => {
    expect(resolvePriceCents(applied(base), "truck_suv")).toBe(29900)
    expect(resolvePriceCents(applied({ ...base, priceDollars: 349 }), "truck_suv")).toBe(
      34900
    )
  })

  it("adding a size-class price overrides only that size", () => {
    const edited = applied({
      ...base,
      priceBySizeDollars: { truck_suv: 359 },
    })
    expect(resolvePriceCents(edited, "truck_suv")).toBe(35900)
    expect(resolvePriceCents(edited, "sedan")).toBe(29900) // fallback holds
    expect(describePrice(edited, "truck_suv")).toBe("$359")
  })

  it("blanking a size-class price falls back again", () => {
    const cleared = applied({
      ...base,
      priceBySizeDollars: { truck_suv: null },
    })
    expect(resolvePriceCents(cleared, "truck_suv")).toBe(29900)
  })

  it("duration-by-size follows the same rule", () => {
    const edited = applied({
      ...base,
      durationBySizeMinutes: { truck_suv: 300 },
    })
    expect(resolveDurationMinutes(edited, "truck_suv")).toBe(300)
    expect(resolveDurationMinutes(edited, "sedan")).toBe(240)
  })

  it("editor multipliers apply through the shared module", () => {
    const edited = applied({
      ...base,
      multipliers: [
        { label: "Heavy soiling", multiplier: 1.25 },
        { label: "", multiplier: 2 }, // blank label → dropped
        { label: "Broken", multiplier: -1 }, // invalid factor → dropped
      ],
    })
    expect(
      applyConditionMultipliers(29900, edited, ["heavy_soiling"])
    ).toBe(37375)
    expect(edited.condition_multipliers).toHaveLength(1)
  })

  it("multiplierKey slugifies labels stably", () => {
    expect(multiplierKey("Heavy soiling / pet hair")).toBe("heavy_soiling_pet_hair")
  })
})

describe("detailer template", () => {
  it("every template service resolves a positive price for every size class", () => {
    for (const entry of DETAILER_TEMPLATE_MENU) {
      const svc = applied(entry)
      for (const size of VEHICLE_SIZE_CLASSES) {
        const price = resolvePriceCents(svc, size)
        expect(price, `${entry.name} @ ${size}`).toBeGreaterThan(0)
        expect(resolveDurationMinutes(svc, size)).toBeGreaterThan(0)
      }
    }
  })

  it("add-ons are flagged and sized services carry maps", () => {
    const addons = DETAILER_TEMPLATE_MENU.filter((e) => e.isAddon)
    expect(addons.length).toBeGreaterThan(0)
    const ceramic = applied(
      DETAILER_TEMPLATE_MENU.find((e) => e.name === "Ceramic Coating")!
    )
    expect(resolvePriceCents(ceramic, "truck_suv")).toBe(119900)
    expect(resolvePriceCents(ceramic, "rv")).toBe(99900) // unpriced size → fallback
  })
})
