import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"

export type ShopContext = {
  id: string
  name: string
}

/** Cookie that remembers which shop the operator most recently picked. */
export const ACTIVE_SHOP_COOKIE = "gradia_active_shop"

export async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect("/login")
  }
  return user
}

/**
 * Resolves the operator's "active shop" with this preference order:
 *   1. The shop id in the `gradia_active_shop` cookie, *if* the
 *      current user actually owns it (RLS would block any read
 *      otherwise — we still double-check for the redirect path).
 *   2. The oldest shop the user owns (stable across sessions).
 *
 * Returns null when the user has zero shops — callers redirect to
 * /onboarding from there.
 */
export async function getOptionalShop(): Promise<ShopContext | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return null
  }

  // Cookie-pinned shop, if still owned.
  const cookieStore = await cookies()
  const pinned = cookieStore.get(ACTIVE_SHOP_COOKIE)?.value
  if (pinned) {
    const { data: pinnedShop } = await supabase
      .from("shops")
      .select("id, name")
      .eq("owner_id", user.id)
      .eq("id", pinned)
      .maybeSingle()
    if (pinnedShop) return pinnedShop as ShopContext
  }

  const { data: shop, error } = await supabase
    .from("shops")
    .select("id, name")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error || !shop) {
    return null
  }

  return shop as ShopContext
}

export async function requireShop(): Promise<ShopContext> {
  const shop = await getOptionalShop()
  if (!shop) {
    redirect("/onboarding")
  }
  return shop
}

/** All shops the current user owns, oldest first. Used by the shop switcher. */
export async function listShopsForCurrentUser(): Promise<ShopContext[]> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from("shops")
    .select("id, name")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data as ShopContext[]
}
