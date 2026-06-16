import { describe, it, expect } from "vitest"

import { hasPackage2, isPaid } from "@/lib/entitlements"
import type { ShopRow } from "@/lib/types/database"

/**
 * Tier 1 — pure, deterministic. Locks the plan-entitlement predicates that
 * all three gates depend on (autonomy clamp, scheduler paid-gate, voice).
 * Packaging: Core = active plan; Package 2 = active + voice add-on. free and
 * past_due are never entitled (fail-closed; no free packages).
 */

const mk = (plan: ShopRow["plan"], voice_addon = false) =>
  ({ plan, voice_addon }) as Pick<ShopRow, "plan" | "voice_addon">

describe("isPaid — active plan only", () => {
  it("is true only for an active subscription", () => {
    expect(isPaid(mk("active"))).toBe(true)
    expect(isPaid(mk("free"))).toBe(false)
    expect(isPaid(mk("past_due"))).toBe(false)
  })
})

describe("hasPackage2 — active plan AND voice add-on", () => {
  it("requires both the active plan and the add-on flag", () => {
    expect(hasPackage2(mk("active", true))).toBe(true)
    expect(hasPackage2(mk("active", false))).toBe(false) // Core
  })

  it("is never granted to an unpaid plan even with the add-on flag set", () => {
    expect(hasPackage2(mk("free", true))).toBe(false)
    expect(hasPackage2(mk("past_due", true))).toBe(false)
  })
})
