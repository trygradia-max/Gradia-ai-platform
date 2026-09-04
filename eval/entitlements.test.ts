import { describe, it, expect } from "vitest"

import {
  hasAutonomy,
  hasTeamSeats,
  hasVoice,
  includedCreditsThisPeriod,
  includedMinutesThisPeriod,
  isInTrial,
  isPaid,
  shopTier,
} from "@/lib/entitlements"
import type { ShopRow } from "@/lib/types/database"

/**
 * Tier 1 — pure, deterministic. Locks the plan-entitlement predicates
 * (P0-013 — D-031 Core $99 / Pro $149 / Operator $249, D-034 contents, D-035
 * trial) that the autonomy clamp, scheduler paid-gate and voice gate depend
 * on. `plan` is subscription STATUS; `tier` is WHICH plan. free/past_due are
 * never entitled (fail-closed; no free packages), whatever the tier says.
 */

type Fields = Pick<
  ShopRow,
  "plan" | "tier" | "voice_addon" | "trial_ends_at"
>

const mk = (input: Partial<Fields> = {}): Fields => ({
  plan: "active",
  tier: "core",
  voice_addon: false,
  trial_ends_at: null,
  ...input,
})

describe("isPaid — active plan only", () => {
  it("is true only for an active subscription", () => {
    expect(isPaid(mk({ plan: "active" }))).toBe(true)
    expect(isPaid(mk({ plan: "free" }))).toBe(false)
    expect(isPaid(mk({ plan: "past_due" }))).toBe(false)
  })
})

describe("shopTier — defensive read", () => {
  it("reads the stored tier", () => {
    expect(shopTier(mk({ tier: "pro" }))).toBe("pro")
    expect(shopTier(mk({ tier: "operator" }))).toBe("operator")
  })

  it("an unrecognized tier value reads as core, never a guessed upgrade", () => {
    expect(shopTier({ tier: "not-a-tier" as never })).toBe("core")
    expect(shopTier({ tier: null as never })).toBe("core")
  })
})

describe("hasVoice — Pro and Operator, or the retired add-on flag, while paid", () => {
  it("Core has no voice", () => {
    expect(hasVoice(mk({ tier: "core" }))).toBe(false)
  })

  it("Pro and Operator have voice", () => {
    expect(hasVoice(mk({ tier: "pro" }))).toBe(true)
    expect(hasVoice(mk({ tier: "operator" }))).toBe(true)
  })

  it("the retired voice_addon flag still grants voice on a Core pilot shop (transition override)", () => {
    expect(hasVoice(mk({ tier: "core", voice_addon: true }))).toBe(true)
  })

  it("never granted to an unpaid plan, even with voice_addon set", () => {
    expect(hasVoice(mk({ plan: "free", tier: "pro", voice_addon: true }))).toBe(false)
    expect(hasVoice(mk({ plan: "past_due", tier: "operator" }))).toBe(false)
  })
})

describe("hasAutonomy — Pro and Operator, or the retired add-on flag, while paid", () => {
  it("Core has no earned autonomy", () => {
    expect(hasAutonomy(mk({ tier: "core" }))).toBe(false)
  })

  it("Pro and Operator have earned autonomy", () => {
    expect(hasAutonomy(mk({ tier: "pro" }))).toBe(true)
    expect(hasAutonomy(mk({ tier: "operator" }))).toBe(true)
  })

  it("the retired voice_addon flag still grants autonomy on a Core pilot shop", () => {
    expect(hasAutonomy(mk({ tier: "core", voice_addon: true }))).toBe(true)
  })

  it("never granted to an unpaid plan", () => {
    expect(hasAutonomy(mk({ plan: "free", tier: "operator" }))).toBe(false)
  })
})

describe("hasTeamSeats — Operator only, while paid", () => {
  it("only Operator gets team seats", () => {
    expect(hasTeamSeats(mk({ tier: "core" }))).toBe(false)
    expect(hasTeamSeats(mk({ tier: "pro" }))).toBe(false)
    expect(hasTeamSeats(mk({ tier: "operator" }))).toBe(true)
  })

  it("never granted to an unpaid plan", () => {
    expect(hasTeamSeats(mk({ plan: "past_due", tier: "operator" }))).toBe(false)
  })
})

describe("isInTrial — a Stripe trial running on a paid subscription", () => {
  it("true while trial_ends_at is in the future", () => {
    const now = new Date("2026-06-01T00:00:00Z")
    expect(
      isInTrial(mk({ trial_ends_at: "2026-06-15T00:00:00Z" }), now)
    ).toBe(true)
  })

  it("false once the trial end has passed", () => {
    const now = new Date("2026-06-20T00:00:00Z")
    expect(
      isInTrial(mk({ trial_ends_at: "2026-06-15T00:00:00Z" }), now)
    ).toBe(false)
  })

  it("false with no trial_ends_at, or unpaid", () => {
    expect(isInTrial(mk({ trial_ends_at: null }))).toBe(false)
    expect(isInTrial(mk({ plan: "free", trial_ends_at: "2099-01-01T00:00:00Z" }))).toBe(false)
  })
})

describe("includedCreditsThisPeriod — tier allowance, trial shrinks it, unpaid is zero", () => {
  it("the tier's included credits while paid and not trialing", () => {
    expect(includedCreditsThisPeriod(mk({ tier: "core" }))).toBe(7000)
    expect(includedCreditsThisPeriod(mk({ tier: "pro" }))).toBe(6000)
    expect(includedCreditsThisPeriod(mk({ tier: "operator" }))).toBe(10000)
  })

  it("the D-035 trial allowance while a trial is running, regardless of tier", () => {
    const now = new Date("2026-06-01T00:00:00Z")
    expect(
      includedCreditsThisPeriod(
        mk({ tier: "operator", trial_ends_at: "2026-06-15T00:00:00Z" }),
        now
      )
    ).toBe(500)
  })

  it("zero for an unpaid shop", () => {
    expect(includedCreditsThisPeriod(mk({ plan: "free" }))).toBe(0)
    expect(includedCreditsThisPeriod(mk({ plan: "past_due" }))).toBe(0)
  })
})

describe("includedMinutesThisPeriod — only shops with voice, trial shrinks it", () => {
  it("zero for Core (no voice)", () => {
    expect(includedMinutesThisPeriod(mk({ tier: "core" }))).toBe(0)
  })

  it("the tier's included minutes for Pro/Operator", () => {
    expect(includedMinutesThisPeriod(mk({ tier: "pro" }))).toBe(100)
    expect(includedMinutesThisPeriod(mk({ tier: "operator" }))).toBe(180)
  })

  it("the D-035 trial minutes while trialing, even on a voice tier", () => {
    const now = new Date("2026-06-01T00:00:00Z")
    expect(
      includedMinutesThisPeriod(
        mk({ tier: "pro", trial_ends_at: "2026-06-15T00:00:00Z" }),
        now
      )
    ).toBe(15)
  })

  it("the retired voice_addon flag grants the TIER's minutes, never the old $29 bundle's 60", () => {
    // Core + voice_addon has voice (transition override) but Core's own
    // minute allowance is 0 — the transition must not resurrect Package 2.
    expect(includedMinutesThisPeriod(mk({ tier: "core", voice_addon: true }))).toBe(0)
  })
})
