"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { creditsSpentThisPeriod } from "@/lib/credits"
import { requireShop, requireUser } from "@/lib/shop"
import { createSubscriptionCheckoutSession } from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
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

/** Starts Stripe Checkout for the $20/mo plan; client redirects to the URL. */
export async function startSubscriptionCheckout(): Promise<CheckoutResult> {
  const user = await requireUser()
  const shop = await requireShop()
  try {
    const session = await createSubscriptionCheckoutSession({
      shopId: shop.id,
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

export type CreditUsage = {
  spent: number
  limit: number
  remaining: number
  plan: string
}

export async function getCreditUsage(): Promise<CreditUsage> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("id, plan, credit_limit, credit_period_start")
    .eq("id", shop.id)
    .single()
  const row =
    (data as Pick<
      ShopRow,
      "id" | "plan" | "credit_limit" | "credit_period_start"
    > | null) ?? null
  if (!row) return { spent: 0, limit: 0, remaining: 0, plan: "free" }
  const spent = await creditsSpentThisPeriod(supabase, {
    id: row.id,
    credit_period_start: row.credit_period_start,
  })
  return {
    spent,
    limit: row.credit_limit,
    remaining: Math.max(0, row.credit_limit - spent),
    plan: row.plan,
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
