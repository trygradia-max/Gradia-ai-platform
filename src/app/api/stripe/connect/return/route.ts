/**
 * Stripe Connect onboarding return URL. Stripe sends the user here
 * after they finish (or abandon) the hosted flow. We refetch the
 * connected account to update `stripe_charges_enabled`, then redirect
 * to /settings with a success/needs-more flag.
 *
 * Stripe doesn't pass back the account id in the URL — we rely on
 * the shop row we set during /start to know which acct_XXX to refetch.
 */

import { redirect } from "next/navigation"

import { requireShop } from "@/lib/shop"
import { getConnectedAccount } from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const { data: shopRow } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  const shop = (shopRow as ShopRow | null) ?? null

  if (!shop?.stripe_account_id) {
    redirect("/settings?stripe=no_account")
  }

  try {
    const account = await getConnectedAccount(shop.stripe_account_id)
    await supabase
      .from("shops")
      .update({ stripe_charges_enabled: account.charges_enabled })
      .eq("id", shop.id)

    redirect(
      `/settings?stripe=${account.charges_enabled ? "ok" : "needs_more"}`
    )
  } catch (err) {
    console.error("[stripe/connect/return] account fetch failed:", err)
    redirect("/settings?stripe=fetch_failed")
  }
}
