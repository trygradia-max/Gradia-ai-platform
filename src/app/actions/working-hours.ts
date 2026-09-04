"use server"

import { revalidatePath } from "next/cache"

import { markVoiceStale } from "@/lib/voice-provider"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import {
  parseTimeMinutes,
  WEEKDAYS,
  type WorkingHours,
} from "@/lib/working-hours"

export type SaveHoursResult = { ok: true } | { ok: false; error: string }

/** Persist per-day working hours into shops.settings.calendar (jsonb —
 *  no migration). Marks voice stale: the phone agent speaks these hours. */
export async function saveWorkingHours(
  input: WorkingHours
): Promise<SaveHoursResult> {
  for (const day of WEEKDAYS) {
    const h = input[day]
    if (h === null) continue
    if (!h || parseTimeMinutes(h.open) == null || parseTimeMinutes(h.close) == null) {
      return { ok: false, error: "Times need to look like 09:00." }
    }
    if (parseTimeMinutes(h.close)! <= parseTimeMinutes(h.open)!) {
      return { ok: false, error: "Closing time has to come after opening." }
    }
  }

  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shop.id)
    .maybeSingle()
  const settings =
    ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  const calendar = (settings.calendar ?? {}) as Record<string, unknown>

  const { error } = await supabase
    .from("shops")
    .update({
      settings: {
        ...settings,
        calendar: { ...calendar, working_hours: input },
      },
    })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }

  await markVoiceStale(supabase, shop.id) // the agent's hours line changed
  revalidatePath("/settings")
  revalidatePath("/calendar")
  revalidatePath("/onboarding") // B-16: the wizard's hours step saves here too
  return { ok: true }
}
