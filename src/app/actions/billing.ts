"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  creditAllowanceThisPeriod,
  creditsSpentThisPeriod,
} from "@/lib/credits"
import { hasVoice, isInTrial, shopTier } from "@/lib/entitlements"
import { humanUnits, PLAN, tierSpec } from "@/lib/pricing"
import { requireShop, requireUser } from "@/lib/shop"
import {
  changeSubscriptionTier,
  createPackCheckoutSession,
  createSubscriptionCheckoutSession,
} from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import { voiceBudgetState } from "@/lib/voice-provider"
import type { ShopPlan, ShopRow, ShopTier } from "@/lib/types/database"

function appBaseUrl(): string {
  const url = process.env.GRADIA_DASHBOARD_URL?.trim()
  try {
    return url ? new URL(url).origin : "http://localhost:3000"
  } catch {
    return "http://localhost:3000"
  }
}

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

const tierSchema = z.enum(["core", "pro", "operator"])

/** Starts Stripe Checkout for one tier (P0-013 — D-031/D-034); the client
 *  redirects. The tier is re-derived by the webhook from the Price id. */
export async function startSubscriptionCheckout(
  tier: ShopTier
): Promise<CheckoutResult> {
  const user = await requireUser()
  const shop = await requireShop()
  const parsed = tierSchema.safeParse(tier)
  if (!parsed.success) return { ok: false, error: "Pick a plan first." }
  try {
    const session = await createSubscriptionCheckoutSession({
      shopId: shop.id,
      tier: parsed.data,
      customerEmail: user.email ?? null,
      successUrl: `${appBaseUrl()}/dashboard?subscribed=1`,
      cancelUrl: `${appBaseUrl()}/billing`,
    })
    if (!session.url) {
      return { ok: false, error: "Stripe returned no checkout URL." }
    }
    return { ok: true, url: session.url }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't start checkout.",
    }
  }
}

/** One-time top-up pack checkout (PLAN.CREDIT_PACK / PLAN.MINUTE_PACK). */
export async function startPackCheckout(
  pack: "credit" | "minute"
): Promise<CheckoutResult> {
  const user = await requireUser()
  const shop = await requireShop()
  try {
    const session = await createPackCheckoutSession({
      shopId: shop.id,
      pack,
      customerEmail: user.email ?? null,
      successUrl: `${appBaseUrl()}/billing?topup=1`,
      cancelUrl: `${appBaseUrl()}/billing`,
    })
    if (!session.url) {
      return { ok: false, error: "Stripe returned no checkout URL." }
    }
    return { ok: true, url: session.url }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't start checkout.",
    }
  }
}

export type ChangeTierResult = { ok: true } | { ok: false; error: string }

/**
 * Upgrade / downgrade the live subscription to another tier (prorated by
 * Stripe). The shop's tier changes when Stripe confirms through the webhook
 * — nothing is written here.
 */
export async function changePlanTier(tier: ShopTier): Promise<ChangeTierResult> {
  await requireUser()
  const shopCtx = await requireShop()
  const parsed = tierSchema.safeParse(tier)
  if (!parsed.success) return { ok: false, error: "Pick a plan first." }
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("stripe_subscription_id, tier")
    .eq("id", shopCtx.id)
    .single()
  const row = (data as Pick<ShopRow, "stripe_subscription_id" | "tier"> | null) ?? null
  if (!row?.stripe_subscription_id) {
    return { ok: false, error: "Subscribe to Gradia first — then change plans here." }
  }
  if (row.tier === parsed.data) {
    return { ok: false, error: `You're already on ${tierSpec(parsed.data).label}.` }
  }
  try {
    await changeSubscriptionTier(row.stripe_subscription_id, parsed.data)
    revalidatePath("/billing")
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't change the plan.",
    }
  }
}

export type UsageState = {
  /** Subscription status. */
  plan: ShopPlan
  /** Which plan (P0-013). Meaningful when plan is active or past_due. */
  tier: ShopTier
  tierLabel: string
  /** Voice receptionist entitlement (Pro/Operator, or the retired add-on flag). */
  voice: boolean
  /** True while the Stripe trial runs — allowances are the trial numbers. */
  inTrial: boolean
  trialEndsAt: string | null
  credits: {
    used: number
    allowance: number
    remaining: number
    warn: boolean
    over: boolean
  }
  minutes: {
    used: number
    allowance: number
    remaining: number
    warn: boolean
    over: boolean
  }
  /** Human-units framing (copy rule: never bare credits as headline). */
  human: { texts: number; emails: number; calls: number | null }
}

/** The two meters (they never cross), with 80% warn flags + human units. */
export async function getUsageState(): Promise<UsageState> {
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (data as ShopRow | null) ?? null
  if (!shop) {
    return {
      plan: "free",
      tier: "core",
      tierLabel: tierSpec("core").label,
      voice: false,
      inTrial: false,
      trialEndsAt: null,
      credits: { used: 0, allowance: 0, remaining: 0, warn: false, over: false },
      minutes: { used: 0, allowance: 0, remaining: 0, warn: false, over: false },
      human: { texts: 0, emails: 0, calls: null },
    }
  }

  const [allowance, spent, voiceState] = await Promise.all([
    creditAllowanceThisPeriod(supabase, shop),
    creditsSpentThisPeriod(supabase, shop),
    voiceBudgetState(supabase, shop),
  ])
  const creditsRemaining = Math.max(0, allowance - spent)
  const minutesAllowance = voiceState.budget ?? 0
  const minutesRemaining = Math.max(0, minutesAllowance - voiceState.usedMinutes)
  const voice = hasVoice(shop)
  const tier = shopTier(shop)

  return {
    plan: shop.plan,
    tier,
    tierLabel: tierSpec(tier).label,
    voice,
    inTrial: isInTrial(shop),
    trialEndsAt: shop.trial_ends_at,
    credits: {
      used: spent,
      allowance,
      remaining: creditsRemaining,
      warn: allowance > 0 && spent >= allowance * PLAN.WARN_FRACTION,
      over: allowance > 0 && spent >= allowance,
    },
    minutes: {
      used: voiceState.usedMinutes,
      allowance: minutesAllowance,
      remaining: minutesRemaining,
      warn: voiceState.warn,
      over: voiceState.over,
    },
    human: humanUnits({
      creditsRemaining,
      minutesRemaining: voice ? minutesRemaining : null,
    }),
  }
}

/** @deprecated kept for the legacy settings card — prefer getUsageState. */
export type CreditUsage = {
  spent: number
  limit: number
  remaining: number
  plan: string
}

export async function getCreditUsage(): Promise<CreditUsage> {
  const state = await getUsageState()
  return {
    spent: state.credits.used,
    limit: state.credits.allowance,
    remaining: state.credits.remaining,
    plan: state.plan,
  }
}

const limitSchema = z.object({ limit: z.number().int().min(0).max(1_000_000) })

export type UpdateLimitResult = { ok: true } | { ok: false; error: string }

export async function updateCreditLimit(
  limit: number
): Promise<UpdateLimitResult> {
  await requireUser()
  const shop = await requireShop()
  const parsed = limitSchema.safeParse({ limit })
  if (!parsed.success) {
    return {
      ok: false,
      error: "Enter a whole number between 0 and 1,000,000.",
    }
  }
  const supabase = await createClient()
  const { error } = await supabase
    .from("shops")
    .update({ credit_limit: parsed.data.limit })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings")
  return { ok: true }
}
