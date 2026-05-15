/**
 * Starts Stripe Connect onboarding for the current shop:
 *   1. If we don't have a connected account yet, create one
 *      (Standard, country=US).
 *   2. Create an account link (Stripe-hosted onboarding URL).
 *   3. Persist the acct_XXX id on the shop row so a refresh later
 *      reuses the same account.
 *   4. Redirect the operator to the hosted flow.
 */

import { redirect } from "next/navigation"
import { headers } from "next/headers"

import { requireShop } from "@/lib/shop"
import {
  createAccountOnboardingLink,
  createConnectedAccount,
  getConnectedAccount,
} from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function resolveOrigin(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

export async function GET() {
  const shopCtx = await requireShop()

  if (
    !process.env.STRIPE_SECRET_KEY?.trim() ||
    !process.env.STRIPE_CONNECT_CLIENT_ID?.trim()
  ) {
    return new Response(
      "Stripe is not configured on this server yet.",
      { status: 500 }
    )
  }

  const supabase = await createClient()
  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (shopRow as ShopRow | null) ?? null
  if (!shop) {
    return new Response("Shop not found.", { status: 404 })
  }

  let accountId = shop.stripe_account_id
  if (!accountId) {
    try {
      const account = await createConnectedAccount({})
      accountId = account.id
      await supabase
        .from("shops")
        .update({
          stripe_account_id: account.id,
          stripe_charges_enabled: account.charges_enabled,
        })
        .eq("id", shop.id)
    } catch (err) {
      console.error("[stripe/connect/start] account create failed:", err)
      redirect("/settings?stripe=account_create_failed")
    }
  } else {
    // Refresh stored charges_enabled flag in case the shop re-onboards.
    try {
      const account = await getConnectedAccount(accountId)
      await supabase
        .from("shops")
        .update({ stripe_charges_enabled: account.charges_enabled })
        .eq("id", shop.id)
    } catch (err) {
      console.warn("[stripe/connect/start] account refresh failed:", err)
    }
  }

  const origin = await resolveOrigin()
  try {
    const link = await createAccountOnboardingLink({
      accountId: accountId!,
      refreshUrl: `${origin}/api/stripe/connect/start`,
      returnUrl: `${origin}/api/stripe/connect/return`,
    })
    redirect(link.url)
  } catch (err) {
    console.error("[stripe/connect/start] link create failed:", err)
    redirect("/settings?stripe=link_failed")
  }
}
