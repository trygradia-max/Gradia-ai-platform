import { describe, expect, it } from "vitest"

import {
  quoteCommercialPeriod,
  quoteUsageCharge,
  validateCommercialCatalog,
} from "@/lib/commercial-pricing"

const fictionalCatalog = {
  currency: "usd",
  plans: [
    {
      key: "test-plan",
      label: "Fictional test plan",
      monthlyBaseCents: 12_345,
      includedSeats: 2,
      extraSeatCents: 1_111,
      payg: {
        mode: "postpaid",
        monthlyCapCents: 5_000,
        rates: [
          {
            metric: "voice_agent_minute",
            unitLabel: "voice-agent minute",
            includedQuantity: 10,
            pricing: {
              kind: "markup",
              multiplierBps: 25_000,
              minimumRetailUnitCents: 20,
            },
          },
        ],
      },
    },
  ],
} as const

describe("commercial catalog validation", () => {
  it("accepts a complete explicit hybrid catalog", () => {
    expect(validateCommercialCatalog(fictionalCatalog).ok).toBe(true)
  })

  it("fails closed when a launched plan omits price or seat terms", () => {
    const invalid = {
      currency: "usd",
      plans: [{ key: "missing", label: "Missing", payg: { mode: "disabled", monthlyCapCents: null, rates: [] } }],
    }
    const result = validateCommercialCatalog(invalid)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("monthlyBaseCents")
      expect(result.issues.join(" ")).toContain("includedSeats")
    }
  })

  it("requires a positive explicit cap for postpaid usage", () => {
    const invalid = {
      ...fictionalCatalog,
      plans: [
        {
          ...fictionalCatalog.plans[0],
          payg: { ...fictionalCatalog.plans[0].payg, monthlyCapCents: 0 },
        },
      ],
    }
    const result = validateCommercialCatalog(invalid)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(" ")).toContain("monthly cap")
  })
})

describe("hybrid invoice quotation", () => {
  const parsed = validateCommercialCatalog(fictionalCatalog)
  if (!parsed.ok) throw new Error("fictional catalog must be valid")
  const plan = parsed.catalog.plans[0]

  it("combines tier base, active-user seats and marked-up usage", () => {
    const quote = quoteCommercialPeriod({
      plan,
      activeSeats: 4,
      usage: [
        {
          metric: "voice_agent_minute",
          periodQuantity: 14,
          wholesaleUnitCostCents: 12,
        },
      ],
    })
    expect(quote).toMatchObject({
      ok: true,
      baseCents: 12_345,
      extraSeats: 2,
      seatChargeCents: 2_222,
      usageChargeCents: 120,
      totalCents: 14_687,
    })
  })

  it("charges no usage overage inside the included quantity", () => {
    const quote = quoteUsageCharge(plan.payg, {
      metric: "voice_agent_minute",
      periodQuantity: 10,
      wholesaleUnitCostCents: 12,
      alreadyChargedCents: 0,
    })
    expect(quote).toMatchObject({ ok: true, overageQuantity: 0, chargeCents: 0 })
  })

  it("uses the configured floor when it is higher than the explicit markup", () => {
    const quote = quoteUsageCharge(plan.payg, {
      metric: "voice_agent_minute",
      periodQuantity: 11,
      wholesaleUnitCostCents: 2,
      alreadyChargedCents: 0,
    })
    expect(quote).toMatchObject({ ok: true, retailUnitCents: 20, chargeCents: 20 })
  })

  it("stops rather than crossing the configured monthly cap", () => {
    const quote = quoteUsageCharge(plan.payg, {
      metric: "voice_agent_minute",
      periodQuantity: 12,
      wholesaleUnitCostCents: 12,
      alreadyChargedCents: 4_950,
    })
    expect(quote).toEqual({ ok: false, reason: "cap_exceeded" })
  })

  it("does not turn disabled PAYG into an implicit charge", () => {
    const quote = quoteUsageCharge(
      { ...plan.payg, mode: "disabled" },
      {
        metric: "voice_agent_minute",
        periodQuantity: 11,
        wholesaleUnitCostCents: 12,
        alreadyChargedCents: 0,
      }
    )
    expect(quote).toEqual({ ok: false, reason: "payg_disabled" })
  })
})
