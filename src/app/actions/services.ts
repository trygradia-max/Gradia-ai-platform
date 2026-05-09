"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import { requireShop } from "@/lib/shop"
import type { ServiceRow } from "@/lib/types/database"

const addServiceSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().max(2000).nullable().optional(),
  priceDollars: z
    .number()
    .min(0, "Price can't be negative")
    .max(1_000_000),
  durationHours: z
    .number()
    .min(0.05, "Duration must be at least a few minutes")
    .max(48),
})

export type AddServiceResult =
  | { ok: true; service: ServiceRow }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

export async function addService(
  input: z.infer<typeof addServiceSchema>
): Promise<AddServiceResult> {
  const parsed = addServiceSchema.safeParse(input)
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

  const shop = await requireShop()
  const supabase = await createClient()

  const priceCents = Math.round(parsed.data.priceDollars * 100)
  const durationMinutes = Math.max(
    1,
    Math.round(parsed.data.durationHours * 60)
  )

  const { data, error } = await supabase
    .from("services")
    .insert({
      shop_id: shop.id,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || null,
      price_cents: priceCents,
      duration_minutes: durationMinutes,
    })
    .select("*")
    .single()

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save service." }
  }

  revalidatePath("/onboarding")
  revalidatePath("/settings")
  return { ok: true, service: data as ServiceRow }
}

export async function deleteService(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: "Missing service id" }

  await requireShop()
  const supabase = await createClient()
  const { error } = await supabase.from("services").delete().eq("id", id)

  if (error) {
    return { ok: false, error: error.message }
  }

  revalidatePath("/onboarding")
  revalidatePath("/settings")
  return { ok: true }
}
