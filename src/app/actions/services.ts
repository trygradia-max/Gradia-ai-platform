"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { createClient } from "@/lib/supabase/server"
import {
  buildServicePatches,
  DETAILER_TEMPLATE_MENU,
  type ServiceMenuInput,
} from "@/lib/service-menu"
import { requireShop } from "@/lib/shop"
import type { ServiceRow } from "@/lib/types/database"
import { markVoiceStale } from "@/lib/voice-provider"

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

  await markVoiceStale(supabase, shop.id) // menu changed — re-sync voice
  revalidatePath("/onboarding")
  revalidatePath("/settings")
  return { ok: true, service: data as ServiceRow }
}

const sizeDollars = z
  .record(z.string(), z.number().min(0).max(1_000_000).nullable())
  .optional()
const sizeMinutes = z
  .record(z.string(), z.number().min(0).max(48 * 60).nullable())
  .optional()

const menuInputSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().max(2000).nullable().optional(),
  priceDollars: z.number().min(0).max(1_000_000),
  durationMinutes: z.number().min(1).max(48 * 60),
  category: z.string().max(60).nullable().optional(),
  priceBySizeDollars: sizeDollars,
  durationBySizeMinutes: sizeMinutes,
  multipliers: z
    .array(z.object({ label: z.string().max(60), multiplier: z.number() }))
    .max(12)
    .optional(),
  isAddon: z.boolean().optional(),
  addonEligible: z.boolean().optional(),
  mobileEligible: z.boolean().optional(),
  active: z.boolean().optional(),
})

export type MenuSaveResult =
  | { ok: true; service: ServiceRow }
  | { ok: false; error: string }

/**
 * Save one service's full menu entry (C3a). Core columns always write;
 * the C1 size-class columns write best-effort so a pre-migration DB still
 * saves the basics (tolerance pattern). Every quote surface (CRM, voice,
 * Whisper) resolves through service-pricing, so this IS the price change.
 */
export async function updateServiceMenu(
  id: string,
  input: z.infer<typeof menuInputSchema>
): Promise<MenuSaveResult> {
  const parsed = menuInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    }
  }
  const shop = await requireShop()
  const supabase = await createClient()
  const patches = buildServicePatches(parsed.data as ServiceMenuInput)

  const { data, error } = await supabase
    .from("services")
    .update(patches.core)
    .eq("id", id)
    .eq("shop_id", shop.id)
    .select("*")
    .single()
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save service." }
  }

  // Size-class pricing columns exist only post-C1-migration.
  const { data: extended, error: extErr } = await supabase
    .from("services")
    .update(patches.extended)
    .eq("id", id)
    .eq("shop_id", shop.id)
    .select("*")
    .single()
  if (extErr) {
    console.warn("[services] size-class save skipped (pre-C1?):", extErr.message)
  }

  await markVoiceStale(supabase, shop.id) // menu changed — re-sync voice
  revalidatePath("/settings")
  return { ok: true, service: (extended ?? data) as ServiceRow }
}

export type TemplateResult =
  | { ok: true; added: number }
  | { ok: false; error: string }

/** One-tap starter menu (C3a). Skips names the shop already has. */
export async function applyDetailerTemplate(): Promise<TemplateResult> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: existing } = await supabase
    .from("services")
    .select("name")
    .eq("shop_id", shop.id)
  const have = new Set(
    ((existing as { name: string }[] | null) ?? []).map((s) =>
      s.name.trim().toLowerCase()
    )
  )

  let added = 0
  for (const entry of DETAILER_TEMPLATE_MENU) {
    if (have.has(entry.name.trim().toLowerCase())) continue
    const patches = buildServicePatches(entry)
    const { data, error } = await supabase
      .from("services")
      .insert({ shop_id: shop.id, ...patches.core })
      .select("id")
      .single()
    if (error || !data) continue
    added += 1
    // Best-effort size-class fields (pre-migration tolerance).
    const { error: extErr } = await supabase
      .from("services")
      .update(patches.extended)
      .eq("id", (data as { id: string }).id)
    if (extErr) {
      console.warn("[services] template size-class skipped:", extErr.message)
    }
  }

  if (added > 0) await markVoiceStale(supabase, shop.id)
  revalidatePath("/settings")
  return { ok: true, added }
}

export async function deleteService(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!id) return { ok: false, error: "Missing service id" }

  const shop = await requireShop()
  const supabase = await createClient()
  const { error } = await supabase.from("services").delete().eq("id", id)

  if (error) {
    return { ok: false, error: error.message }
  }

  await markVoiceStale(supabase, shop.id)
  revalidatePath("/onboarding")
  revalidatePath("/settings")
  return { ok: true }
}
