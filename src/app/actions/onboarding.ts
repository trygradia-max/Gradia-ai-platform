"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

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
    .update({
      settings: { ...settings, onboarding_done: true, onboarding_step: 3 },
    })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/", "layout")
  return { ok: true }
}

const progressSchema = z
  .object({
    step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    numberSkipped: z.boolean().optional(),
  })
  .strict()

export type SaveOnboardingProgressResult =
  | { ok: true }
  | { ok: false; error: string }

/** Remembers the wizard step so a refresh returns to the same place. */
export async function saveOnboardingProgress(
  input: unknown
): Promise<SaveOnboardingProgressResult> {
  const parsed = progressSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Could not save your place." }

  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shop.id)
    .single()
  const settings: Record<string, unknown> = {
    ...(((data as { settings?: Record<string, unknown> } | null)?.settings) ??
      {}),
    onboarding_step: parsed.data.step,
  }
  if (parsed.data.numberSkipped !== undefined) {
    settings.onboarding_number_skipped = parsed.data.numberSkipped
  }

  const { error } = await supabase
    .from("shops")
    .update({ settings })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/onboarding")
  return { ok: true }
}
