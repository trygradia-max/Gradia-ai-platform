"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  creditAllowanceThisPeriod,
  creditsSpentThisPeriod,
} from "@/lib/credits"
import { humanUnits, PLAN } from "@/lib/pricing"
import { requireShop, requireUser } from "@/lib/shop"
import {
  removeVoiceAddonItem,
} from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import { voiceBudgetState } from "@/lib/voice-provider"
import type { ShopRow } from "@/lib/types/database"

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * The retired two-SKU checkout is deliberately unavailable. The replacement
 * must consume a founder-approved, validated commercial catalog; restoring a
 * legacy Stripe price environment variable cannot silently re-enable it.
 */
export async function startSubscriptionCheckout(_input?: {
  includeVoiceAddon?: boolean
}): Promise<CheckoutResult> {
  void _input
  await requireUser()
  await requireShop()
  return {
    ok: false,
    error: "Pilot checkout is unavailable until your plan, seats, usage rates, and spending cap are confirmed.",
  }
}

/** Retired fixed-price packs stay unavailable with the legacy catalog. */
export async function startPackCheckout(
  _pack: "credit" | "minute"
): Promise<CheckoutResult> {
  void _pack
  await requireUser()
  await requireShop()
  return {
    ok: false,
    error: "Usage purchases are unavailable until the pilot usage policy and spending cap are confirmed.",
  }
}

export type ToggleVoiceAddonResult = { ok: true } | { ok: false; error: string }

/** Existing pilots may remove voice. New legacy add-on purchases are blocked. */
export async function toggleVoiceAddon(
  on: boolean
): Promise<ToggleVoiceAddonResult> {
  await requireUser()
  const shopCtx = await requireShop()
  if (on) {
    return {
      ok: false,
      error: "Contact Gradia to add voice under your confirmed pilot terms.",
    }
  }
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("stripe_subscription_id")
    .eq("id", shopCtx.id)
    .single()
  const subId = (data as { stripe_subscription_id: string | null } | null)
    ?.stripe_subscription_id
  if (!subId) {
    return { ok: false, error: "Subscribe to Gradia first — then add the voice receptionist." }
  }
  try {
    await removeVoiceAddonItem(subId)
    revalidatePath("/billing")
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't update the plan.",
    }
  }
}

export type UsageState = {
  plan: string
  voiceAddon: boolean
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
      voiceAddon: false,
      credits: { used: 0, allowance: 0, remaining: 0, warn: false, over: false },
      minutes: { used: 0, allowance: 0, remaining: 0, warn: false, over: false },
      human: { texts: 0, emails: 0, calls: null },
    }
  }

  const [allowance, spent, voice] = await Promise.all([
    creditAllowanceThisPeriod(supabase, shop),
    creditsSpentThisPeriod(supabase, shop),
    voiceBudgetState(supabase, shop),
  ])
  const creditsRemaining = Math.max(0, allowance - spent)
  const minutesAllowance = voice.budget ?? 0
  const minutesRemaining = Math.max(0, minutesAllowance - voice.usedMinutes)

  return {
    plan: shop.plan,
    voiceAddon: shop.voice_addon,
    credits: {
      used: spent,
      allowance,
      remaining: creditsRemaining,
      warn: allowance > 0 && spent >= allowance * PLAN.WARN_FRACTION,
      over: allowance > 0 && spent >= allowance,
    },
    minutes: {
      used: voice.usedMinutes,
      allowance: minutesAllowance,
      remaining: minutesRemaining,
      warn: voice.warn,
      over: voice.over,
    },
    human: humanUnits({
      creditsRemaining,
      minutesRemaining: shop.voice_addon ? minutesRemaining : null,
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
