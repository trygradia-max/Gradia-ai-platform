"use server"

import { requireShop } from "@/lib/shop"
import {
  createAccountSession,
  createConnectedAccount,
  getConnectedAccount,
} from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export type StripeAccountSessionResult =
  | {
      ok: true
      clientSecret: string
      accountId: string
      chargesEnabled: boolean
    }
  | { ok: false; error: string }

/**
 * Embedded Connect entry point. Mints an Account Session for the
 * current shop's connected account — creating the account first if
 * we don't have one yet — and returns the client_secret the embedded
 * UI needs.
 *
 * Idempotent: calling repeatedly reuses the same acct_xxx and just
 * mints a fresh session secret (~60 min TTL).
 */
export async function getStripeOnboardingSession(): Promise<StripeAccountSessionResult> {
  if (
    !process.env.STRIPE_SECRET_KEY?.trim() ||
    !process.env.STRIPE_CONNECT_CLIENT_ID?.trim()
  ) {
    return {
      ok: false,
      error: "Stripe isn't configured on the server yet.",
    }
  }

  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (shopRow as ShopRow | null) ?? null
  if (!shop) {
    return { ok: false, error: "We couldn't find this shop." }
  }

  let accountId = shop.stripe_account_id
  let chargesEnabled = Boolean(shop.stripe_charges_enabled)

  if (!accountId) {
    try {
      const account = await createConnectedAccount({})
      accountId = account.id
      chargesEnabled = account.charges_enabled
      await supabase
        .from("shops")
        .update({
          stripe_account_id: account.id,
          stripe_charges_enabled: account.charges_enabled,
        })
        .eq("id", shop.id)
    } catch (err) {
      console.error("[stripe-connect] account create failed:", err)
      return {
        ok: false,
        error: "Couldn't create the Stripe account — try again in a moment.",
      }
    }
  } else {
    // Refresh charges_enabled so the UI badge reflects whatever
    // happened on Stripe's side between sessions.
    try {
      const account = await getConnectedAccount(accountId)
      chargesEnabled = account.charges_enabled
      await supabase
        .from("shops")
        .update({ stripe_charges_enabled: account.charges_enabled })
        .eq("id", shop.id)
    } catch (err) {
      console.warn("[stripe-connect] account refresh failed:", err)
    }
  }

  try {
    const session = await createAccountSession({
      accountId: accountId!,
    })
    return {
      ok: true,
      clientSecret: session.client_secret,
      accountId: accountId!,
      chargesEnabled,
    }
  } catch (err) {
    console.error("[stripe-connect] account session failed:", err)
    return {
      ok: false,
      error: "Couldn't open the onboarding panel — try again in a moment.",
    }
  }
}

export type RefreshStripeStatusResult =
  | {
      ok: true
      chargesEnabled: boolean
      detailsSubmitted: boolean
    }
  | { ok: false; error: string }

/**
 * Re-fetches the connected account from Stripe and persists the
 * latest charges_enabled flag. Called by the embedded onboarding's
 * onExit handler so the UI knows whether to flip to "Connected"
 * without a full page reload.
 */
export async function refreshStripeAccountStatus(): Promise<RefreshStripeStatusResult> {
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (shopRow as ShopRow | null) ?? null
  if (!shop?.stripe_account_id) {
    return {
      ok: false,
      error: "No Stripe account to refresh yet.",
    }
  }

  try {
    const account = await getConnectedAccount(shop.stripe_account_id)
    await supabase
      .from("shops")
      .update({ stripe_charges_enabled: account.charges_enabled })
      .eq("id", shop.id)
    return {
      ok: true,
      chargesEnabled: account.charges_enabled,
      detailsSubmitted: account.details_submitted,
    }
  } catch (err) {
    console.error("[stripe-connect] refresh failed:", err)
    return {
      ok: false,
      error: "Couldn't reach Stripe — try again in a moment.",
    }
  }
}
