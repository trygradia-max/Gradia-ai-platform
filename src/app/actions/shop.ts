"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import { getOptionalShop, requireUser } from "@/lib/shop"
import type { ShopRow } from "@/lib/types/database"

const saveShopSchema = z.object({
  name: z.string().min(1, "Shop name is required").max(120),
  location: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
})

export type SaveShopResult =
  | { ok: true; shop: ShopRow }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

/**
 * Idempotent upsert. Creates the shop on first call, updates it on
 * subsequent calls. Used by the onboarding wizard for step 1 and (later)
 * the settings page for ongoing edits.
 */
export async function saveShop(
  input: z.infer<typeof saveShopSchema>
): Promise<SaveShopResult> {
  const parsed = saveShopSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    }
  }

  const user = await requireUser()
  const supabase = await createClient()
  const existing = await getOptionalShop()

  const fields = {
    name: parsed.data.name.trim(),
    location: parsed.data.location?.trim() || null,
    phone: parsed.data.phone?.trim() || null,
  }

  if (existing) {
    const { data, error } = await supabase
      .from("shops")
      .update(fields)
      .eq("id", existing.id)
      .select("*")
      .single()

    if (error || !data) {
      return { ok: false, error: error?.message ?? "Could not update shop." }
    }

    revalidatePath("/", "layout")
    return { ok: true, shop: data as ShopRow }
  }

  const { data, error } = await supabase
    .from("shops")
    .insert({ ...fields, owner_id: user.id, settings: {} })
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not create shop." }
  }

  revalidatePath("/", "layout")
  return { ok: true, shop: data as ShopRow }
}
