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
  addVoiceAddonItem,
  createPackCheckoutSession,
  createSubscriptionCheckoutSession,
  removeVoiceAddonItem,
} from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import { voiceBudgetState } from "@/lib/voice-provider"
import type { ShopRow } from "@/lib/types/database"

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

/** Starts Stripe Checkout for the plan (Core $20/mo, optionally with the
 *  Voice Receptionist add-on as a second item); client redirects. */
export async function startSubscriptionCheckout(input?: {
  includeVoiceAddon?: boolean
}): Promise<CheckoutResult> {
  const user = await requireUser()
  const shop = await requireShop()
  try {
    const session = await createSubscriptionCheckoutSession({
      shopId: shop.id,
      customerEmail: user.email ?? null,
      successUrl: `${appBaseUrl()}/dashboard?subscribed=1`,
      cancelUrl: `${appBaseUrl()}/billing`,
      includeVoiceAddon: input?.includeVoiceAddon ?? false,
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

/** One-time $10 top-up pack checkout (950 credits / 40 minutes). */
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

export type ToggleVoiceAddonResult = { ok: true } | { ok: false; error: string }

/** Adds/removes the +$29 Voice Receptionist item on the live subscription.
 *  The webhook flips shops.voice_addon when Stripe confirms. */
export async function toggleVoiceAddon(
  on: boolean
): Promise<ToggleVoiceAddonResult> {
  await requireUser()
  const shopCtx = await requireShop()
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
    if (on) await addVoiceAddonItem(subId)
    else await removeVoiceAddonItem(subId)
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
