import { describe, expect, it } from "vitest"
import { bookingDurationHold, durationDependsOnSize, matchMenuService } from "@/lib/booking-duration"

const svc = (name: string, duration_minutes = 120, duration_by_size: Record<string, number> | null = null) =>
  ({ id: name, name, duration_minutes, duration_by_size })

describe("menu service matching for booking length", () => {
  const menu = [svc("Full Detail", 180), svc("Ceramic Coating 1 Year", 240), svc("Ceramic Coating 5 Year", 480), svc("Wash")]
  it("prefers an exact name, ignoring case and spacing", () => {
    expect(matchMenuService(menu, "  full   DETAIL ").map(s => s.name)).toEqual(["Full Detail"])
    expect(matchMenuService(menu, "wash").map(s => s.name)).toEqual(["Wash"])
  })
  it("falls back to containment and reports ambiguity instead of picking one", () => {
    expect(matchMenuService(menu, "ceramic coating").map(s => s.name)).toEqual(["Ceramic Coating 1 Year", "Ceramic Coating 5 Year"])
    expect(matchMenuService(menu, "a full detail please").map(s => s.name)).toEqual(["Full Detail"])
  })
  it("never matches an empty or unknown service", () => {
    expect(matchMenuService(menu, "")).toEqual([])
    expect(matchMenuService(menu, null)).toEqual([])
    expect(matchMenuService(menu, "Paint protection film")).toEqual([])
  })
})

describe("size-dependent duration", () => {
  it("depends on size only when a configured size length differs", () => {
    expect(durationDependsOnSize(svc("Flat", 120))).toBe(false)
    expect(durationDependsOnSize(svc("Same", 120, { sedan: 120, truck_suv: 120 }))).toBe(false)
    expect(durationDependsOnSize(svc("Varies", 120, { sedan: 120, truck_suv: 240 }))).toBe(true)
    expect(durationDependsOnSize(svc("One size off", 120, { truck_suv: 180 }))).toBe(true)
  })
  it("explains every hold to the owner without inventing a length", () => {
    for (const reason of ["service_unmatched", "service_ambiguous", "vehicle_size_unknown", "menu_unavailable"] as const)
      expect(bookingDurationHold(reason, "Mystery wash")).toMatch(/^Held — /)
  })
})
