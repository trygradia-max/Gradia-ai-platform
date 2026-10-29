import { z } from "zod"

const cents = z.number().int().nonnegative()
const quantity = z.number().finite().nonnegative()
const slug = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/)

const usagePricingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fixed"),
      retailUnitCents: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("markup"),
      multiplierBps: z.number().int().min(10_000),
      minimumRetailUnitCents: z.number().positive(),
    })
    .strict(),
])

const usageRateSchema = z
  .object({
    metric: slug,
    unitLabel: z.string().trim().min(1).max(80),
    includedQuantity: quantity,
    pricing: usagePricingSchema,
  })
  .strict()

const paygPolicySchema = z
  .object({
    mode: z.enum(["disabled", "prepaid", "postpaid"]),
    monthlyCapCents: cents.nullable(),
    rates: z.array(usageRateSchema),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.mode === "postpaid" && (!policy.monthlyCapCents || policy.monthlyCapCents <= 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["monthlyCapCents"],
        message: "Postpaid usage requires an explicit positive monthly cap.",
      })
    }
    if (policy.mode !== "disabled" && policy.rates.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["rates"],
        message: "Enabled usage billing requires at least one explicit rate.",
      })
    }
    const seen = new Set<string>()
    for (const [index, rate] of policy.rates.entries()) {
      if (seen.has(rate.metric)) {
        ctx.addIssue({
          code: "custom",
          path: ["rates", index, "metric"],
          message: "Usage metrics must be unique within a plan.",
        })
      }
      seen.add(rate.metric)
    }
  })

const commercialPlanSchema = z
  .object({
    key: slug,
    label: z.string().trim().min(1).max(80),
    monthlyBaseCents: cents,
    includedSeats: z.number().int().positive(),
    extraSeatCents: cents,
    payg: paygPolicySchema,
  })
  .strict()

export const commercialCatalogSchema = z
  .object({
    currency: z.literal("usd"),
    plans: z.array(commercialPlanSchema).min(1),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>()
    for (const [index, plan] of catalog.plans.entries()) {
      if (seen.has(plan.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["plans", index, "key"],
          message: "Commercial plan keys must be unique.",
        })
      }
      seen.add(plan.key)
    }
  })

export type CommercialCatalog = z.infer<typeof commercialCatalogSchema>
export type CommercialPlan = z.infer<typeof commercialPlanSchema>
export type PaygPolicy = z.infer<typeof paygPolicySchema>

export type CatalogResult =
  | { ok: true; catalog: CommercialCatalog }
  | { ok: false; issues: string[] }

/**
 * Commercial values have no production defaults. A launched catalog must be
 * complete, explicit and validated; unresolved founder decisions fail closed.
 */
export function validateCommercialCatalog(input: unknown): CatalogResult {
  const parsed = commercialCatalogSchema.safeParse(input)
  if (parsed.success) return { ok: true, catalog: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
      return `${path}${issue.message}`
    }),
  }
}

export type UsageQuoteInput = {
  metric: string
  periodQuantity: number
  wholesaleUnitCostCents: number
  alreadyChargedCents: number
}

export type UsageQuote =
  | {
      ok: true
      metric: string
      overageQuantity: number
      wholesaleOverageCents: number
      retailUnitCents: number
      chargeCents: number
      projectedPeriodChargeCents: number
    }
  | {
      ok: false
      reason: "invalid_usage" | "rate_missing" | "payg_disabled" | "cap_exceeded"
    }

/**
 * Quotes one period-to-date usage metric. Wholesale evidence and retail
 * pricing remain separate. Markup is used only when explicitly configured;
 * the function never invents a multiplier, rate or monthly cap.
 */
export function quoteUsageCharge(
  policy: PaygPolicy,
  input: UsageQuoteInput
): UsageQuote {
  const parsed = z
    .object({
      metric: slug,
      periodQuantity: quantity,
      wholesaleUnitCostCents: z.number().finite().nonnegative(),
      alreadyChargedCents: cents,
    })
    .safeParse(input)
  if (!parsed.success) return { ok: false, reason: "invalid_usage" }

  const rate = policy.rates.find((candidate) => candidate.metric === parsed.data.metric)
  if (!rate) return { ok: false, reason: "rate_missing" }

  const overageQuantity = Math.max(
    0,
    parsed.data.periodQuantity - rate.includedQuantity
  )
  if (overageQuantity === 0) {
    return {
      ok: true,
      metric: rate.metric,
      overageQuantity: 0,
      wholesaleOverageCents: 0,
      retailUnitCents: 0,
      chargeCents: 0,
      projectedPeriodChargeCents: parsed.data.alreadyChargedCents,
    }
  }
  if (policy.mode === "disabled") return { ok: false, reason: "payg_disabled" }

  const retailUnitCents =
    rate.pricing.kind === "fixed"
      ? rate.pricing.retailUnitCents
      : Math.max(
          rate.pricing.minimumRetailUnitCents,
          (parsed.data.wholesaleUnitCostCents * rate.pricing.multiplierBps) / 10_000
        )
  const wholesaleOverageCents = parsed.data.wholesaleUnitCostCents * overageQuantity
  const chargeCents = Math.ceil(retailUnitCents * overageQuantity)
  const projectedPeriodChargeCents = parsed.data.alreadyChargedCents + chargeCents

  if (
    policy.monthlyCapCents !== null &&
    projectedPeriodChargeCents > policy.monthlyCapCents
  ) {
    return { ok: false, reason: "cap_exceeded" }
  }

  return {
    ok: true,
    metric: rate.metric,
    overageQuantity,
    wholesaleOverageCents,
    retailUnitCents,
    chargeCents,
    projectedPeriodChargeCents,
  }
}

export type CommercialQuote =
  | {
      ok: true
      baseCents: number
      activeSeats: number
      extraSeats: number
      seatChargeCents: number
      usageChargeCents: number
      totalCents: number
      usage: Extract<UsageQuote, { ok: true }>[]
    }
  | {
      ok: false
      reason:
        | "invalid_active_seats"
        | "invalid_usage"
        | "rate_missing"
        | "payg_disabled"
        | "cap_exceeded"
    }

/** Pure invoice preview. It performs no collection and does not enable PAYG. */
export function quoteCommercialPeriod(input: {
  plan: CommercialPlan
  activeSeats: number
  usage: Omit<UsageQuoteInput, "alreadyChargedCents">[]
}): CommercialQuote {
  if (!Number.isInteger(input.activeSeats) || input.activeSeats < 0) {
    return { ok: false, reason: "invalid_active_seats" }
  }
  const extraSeats = Math.max(0, input.activeSeats - input.plan.includedSeats)
  const seatChargeCents = extraSeats * input.plan.extraSeatCents
  const usage: Extract<UsageQuote, { ok: true }>[] = []
  let usageChargeCents = 0
  for (const usageInput of input.usage) {
    const quoted = quoteUsageCharge(input.plan.payg, {
      ...usageInput,
      alreadyChargedCents: usageChargeCents,
    })
    if (!quoted.ok) return { ok: false, reason: quoted.reason }
    usage.push(quoted)
    usageChargeCents += quoted.chargeCents
  }
  return {
    ok: true,
    baseCents: input.plan.monthlyBaseCents,
    activeSeats: input.activeSeats,
    extraSeats,
    seatChargeCents,
    usageChargeCents,
    totalCents: input.plan.monthlyBaseCents + seatChargeCents + usageChargeCents,
    usage,
  }
}
