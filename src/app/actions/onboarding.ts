"use server"

import { revalidatePath } from "next/cache"

import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"

export type CompleteOnboardingResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Marks the first-run wizard done for the active shop. The (dashboard)
 * layout stops redirecting to /onboarding once this flips; anything the
 * owner skipped surfaces as Today-page nudges instead
 * (GRADIA_UX_ONBOARDING_SPEC Part 1).
 */
export async function completeOnboarding(): Promise<CompleteOnboardingResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  // settings is a jsonb blob — merge, don't clobber.
  const { data } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shop.id)
    .single()
  const settings =
    ((data as { settings?: Record<string, unknown> } | null)?.settings ??
      {}) as Record<string, unknown>

  const { error } = await supabase
    .from("shops")
    .update({ settings: { ...settings, onboarding_done: true } })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/", "layout")
  return { ok: true }
}
