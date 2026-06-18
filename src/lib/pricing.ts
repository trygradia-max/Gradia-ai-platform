/**
 * Markup pricing — margin lives in config, enforcement lives in code.
 *
 * Retail/wholesale prices come from the admin-editable `pricing_config`
 * table; DEFAULT_PRICING is the documented launch fallback so a missing row
 * can never make a metered action free. Nothing outside this module may
 * hardcode a price or markup (gradia-metering-billing skill rule).
 *
 * Units: plain cents, numeric (sub-cent wholesale is real — an SMS segment
 * costs ~0.79¢). Credits stay the cap currency at 1 credit ≈ 1¢ retail,
 * rounded up so fractional-cent actions are never free.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { PricingConfigRow, PricingKey } from "@/lib/types/database"

export type Pricing = Record<
  PricingKey,
  { wholesale_cents: number; retail_cents: number }
>

/**
 * Locked menu defaults (GRADIA_PRICING.md, 2026-06-11). The DB rows win
 * when present. 1 credit = 1¢ retail; voice minutes are their OWN meter
 * (rows carry costs for margin but credits=0 — the meters never cross).
 */
export const DEFAULT_PRICING: Pricing = {
  number_monthly: { wholesale_cents: 115, retail_cents: 250 },
  voice_minute: { wholesale_cents: 12, retail_cents: 25 },
  sms_segment: { wholesale_cents: 1.2, retail_cents: 4 },
  email_send: { wholesale_cents: 0.3, retail_cents: 1 },
  outreach_draft: { wholesale_cents: 0.3, retail_cents: 1 },
  // ~1.5¢ blended with prompt caching on the system + tool prefix
  // (bi-agent.ts SYSTEM_BLOCKS + buildToolDefinitions, 2026-06-15). First
  // call in a 5-min window writes the cache (~1.25× the prefix); subsequent
  // answers read it (~0.1×). Uncached this was ~2.6¢. Margin at 7 credits ≈ 78%.
  bi_answer: { wholesale_cents: 1.5, retail_cents: 7 },
  whisper_note: { wholesale_cents: 0.9, retail_cents: 3 },
  agentic_plan: { wholesale_cents: 3, retail_cents: 10 },
}

/**
 * SKU structure (GRADIA_PRICING.md). Unit PRICES live in pricing_config;
 * plan STRUCTURE lives here because changing it requires matching Stripe
 * price changes (a deploy) regardless. Two SKUs, volume-gated never
 * feature-gated; the credit and minute meters never cross.
 */
export const PLAN = {
  /** Gradia Core — $20/mo. */
  CORE_PRICE_CENTS: 2000,
  CORE_INCLUDED_CREDITS: 1200,
  /** Voice Receptionist add-on — +$29/mo, number folded in. */
  VOICE_PRICE_CENTS: 2900,
  VOICE_INCLUDED_MINUTES: 60,
  /** Top-up packs — same margin as base. */
  CREDIT_PACK: { credits: 950, priceCents: 1000 },
  MINUTE_PACK: { minutes: 40, priceCents: 1000 },
  /** Up to 25% of unused INCLUDED credits roll one month. */
  ROLLOVER_MAX_FRACTION: 0.25,
  /** Offer packs + warn at 80% usage. */
  WARN_FRACTION: 0.8,
} as const

/** Human-units framing (copy rule: never bare credits as the headline). */
export function humanUnits(input: {
  creditsRemaining: number
  minutesRemaining?: number | null
}): { texts: number; emails: number; calls: number | null } {
  const sms = DEFAULT_PRICING.sms_segment.retail_cents
  const email = DEFAULT_PRICING.email_send.retail_cents
  return {
    texts: Math.max(0, Math.floor(input.creditsRemaining / sms)),
    emails: Math.max(0, Math.floor(input.creditsRemaining / email)),
    // 60 min ≈ 20 answered calls → ~3 min per call.
    calls:
      input.minutesRemaining == null
        ? null
        : Math.max(0, Math.floor(input.minutesRemaining / 3)),
  }
}

/**
 * Billable SMS segments for a message body. GSM-7 approximation: one
 * segment ≤160 chars, multipart at 153 chars each. Unicode bodies cost
 * more in reality — acceptable drift at pilot scale, reconciliation
 * catches systematic gaps.
 */
export function smsSegments(body: string): number {
  const len = body.length
  if (len <= 0) return 1
  if (len <= 160) return 1
  return Math.ceil(len / 153)
}

/** Monthly rollover: up to 25% of unused INCLUDED credits (packs don't
 *  roll). Pure — webhook applies it at renewal. */
export function rolloverCredits(input: {
  includedCredits: number
  spentCredits: number
}): number {
  const unused = Math.max(0, input.includedCredits - input.spentCredits)
  return Math.min(
    unused,
    Math.floor(input.includedCredits * PLAN.ROLLOVER_MAX_FRACTION)
  )
}

const PRICING_KEYS = Object.keys(DEFAULT_PRICING) as PricingKey[]

/** Loads pricing_config rows over the defaults. Never throws — a read
 * failure falls back to DEFAULT_PRICING so metering keeps working. */
export async function getPricing(supabase: SupabaseClient): Promise<Pricing> {
  try {
    const { data, error } = await supabase
      .from("pricing_config")
      .select("key, wholesale_cents, retail_cents")
    if (error) {
      console.error("[pricing] config read failed, using defaults:", error)
      return DEFAULT_PRICING
    }
    const merged: Pricing = { ...DEFAULT_PRICING }
    for (const row of (data as PricingConfigRow[] | null) ?? []) {
      if (PRICING_KEYS.includes(row.key)) {
        merged[row.key] = {
          wholesale_cents: row.wholesale_cents,
          retail_cents: row.retail_cents,
        }
      }
    }
    return merged
  } catch (err) {
    console.error("[pricing] config read threw, using defaults:", err)
    return DEFAULT_PRICING
  }
}

export type PricedUsage = {
  /** Vendor cost in cents. */
  wholesale_cost: number
  /** Shop-facing cost in cents. */
  retail_cost: number
  /** Cap currency: 1 credit ≈ 1¢ retail, rounded UP (never free). */
  credits: number
}

/** Prices a metered quantity. Quantity is clamped at 0 — the ledger is
 * append-only and corrections are compensating entries, not negatives here. */
export function priceUsage(
  pricing: Pricing,
  key: PricingKey,
  quantity = 1
): PricedUsage {
  const qty = Math.max(0, quantity)
  const { wholesale_cents, retail_cents } = pricing[key]
  const wholesale = wholesale_cents * qty
  const retail = retail_cents * qty
  return {
    wholesale_cost: wholesale,
    retail_cost: retail,
    credits: qty === 0 ? 0 : Math.max(1, Math.ceil(retail)),
  }
}

/** Margin in cents for a priced event — must always be computable. */
export function marginCents(priced: PricedUsage): number {
  return priced.retail_cost - priced.wholesale_cost
}
