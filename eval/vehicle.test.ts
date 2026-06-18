import { describe, it, expect } from "vitest"

import { parseVehicle } from "@/lib/vehicle"

/**
 * Tier 1 — pure. Locks the free-text → structured vehicle parser that backs
 * L3 segmentation (and mirrors the SQL backfill). The "ceramic" ≠ Ram case is
 * the load-bearing one: word boundaries must not false-match short makes.
 */

describe("parseVehicle", () => {
  it("reads year, make, model, and color from typical car_info", () => {
    expect(parseVehicle("2021 Tesla Model 3, ceramic")).toEqual({
      make: "Tesla",
      model: "Model 3",
      year: 2021,
      color: null,
    })
    expect(parseVehicle("silver 2020 Honda Civic")).toEqual({
      make: "Honda",
      model: "Civic",
      year: 2020,
      color: "Silver",
    })
  })

  it("normalizes make aliases (chevy → Chevrolet, vw → Volkswagen)", () => {
    expect(parseVehicle("chevy silverado").make).toBe("Chevrolet")
    expect(parseVehicle("'18 VW Golf").make).toBe("Volkswagen")
  })

  it("does NOT match 'ram' inside 'ceramic' (word boundaries)", () => {
    expect(parseVehicle("ceramic coating quote").make).toBeNull()
    expect(parseVehicle("Ram 1500 2019")).toEqual({
      make: "Ram",
      model: "1500",
      year: 2019,
      color: null,
    })
  })

  it("returns all-null for empty input; picks up a bare color", () => {
    expect(parseVehicle(null)).toEqual({ make: null, model: null, year: null, color: null })
    expect(parseVehicle("blue sedan")).toEqual({
      make: null,
      model: null,
      year: null,
      color: "Blue",
    })
  })
})
