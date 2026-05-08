import { redirect } from "next/navigation"

import { createClient } from "@/lib/supabase/server"

export type ShopContext = {
  id: string
  name: string
}

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

export async function getOptionalShop(): Promise<ShopContext | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return null
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

  return shop
}

export async function requireShop(): Promise<ShopContext> {
  const shop = await getOptionalShop()
  if (!shop) {
    redirect("/onboarding")
  }
  return shop
}
