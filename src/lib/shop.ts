import { cache } from "react"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"

export type ShopContext = {
  id: string
  name: string
}

/** Cookie that remembers which shop the operator most recently picked. */
export const ACTIVE_SHOP_COOKIE = "gradia_active_shop"

/**
 * PERF-001: the current user and the active shop are resolved ONCE per
 * server request. Before this, every loader called `auth.getUser()` (a
 * round trip to Supabase Auth) and re-read the shop row — the Home render
 * did it ~21 times (baseline in the PERF-001 ticket). React `cache()` is
 * request-scoped inside a Server Components render (layout + page + every
 * server component share it) and never crosses requests, so there is no
 * cross-tenant cache key to get wrong: a different request is a different
 * cache.
 */
const getCurrentUser = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
})

export async function requireUser() {
  const user = await getCurrentUser()
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
 * /onboarding from there. Memoized per request (see above).
 */
export const getOptionalShop = cache(async (): Promise<ShopContext | null> => {
  const user = await getCurrentUser()
  if (!user) {
    return null
  }
  const supabase = await createClient()

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
})

export async function requireShop(): Promise<ShopContext> {
  const shop = await getOptionalShop()
  if (!shop) {
    redirect("/onboarding")
  }
  return shop
}

/** All shops the current user owns, oldest first. Used by the shop switcher.
 *  Memoized per request. */
export const listShopsForCurrentUser = cache(async (): Promise<ShopContext[]> => {
  const user = await getCurrentUser()
  if (!user) return []
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("shops")
    .select("id, name")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
  if (error || !data) return []
  return data as ShopContext[]
})
