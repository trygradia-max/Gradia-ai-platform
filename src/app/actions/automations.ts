"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  AUTOMATION_CATALOG,
  AUTOMATION_KEYS,
  ensureAutomationRow,
  loadAutomationConfigs,
  type AutomationCatalogKey,
} from "@/lib/automations"
import { isAutomationAutopilotAllowed } from "@/lib/autonomy"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { AutomationMode } from "@/lib/types/database"

/** Settings surface data + writes for the C5 catalog. */

export type AutomationSettingsEntry = {
  key: AutomationCatalogKey
  sentence: string
  detail: string
  enabled: boolean
  mode: AutomationMode
  /** Floor: money/calendar entries can never offer autopilot. */
  autopilotAllowed: boolean
  template: string
  defaultTemplate: string
  stats: { sent: number; staged: number; recoveredBookings: number }
}

export async function getAutomationSettings(): Promise<AutomationSettingsEntry[]> {
  const shop = await requireShop()
  const supabase = await createClient()
  const configs = await loadAutomationConfigs(supabase, shop.id)

  // Run history — one query, grouped in code (list is small).
  const { data: runData } = await supabase
    .from("automation_runs")
    .select("automation_id, status, lead_id, automations!inner(catalog_key)")
    .eq("shop_id", shop.id)
    .limit(2000)
  const runs =
    (runData as
      | { status: string; lead_id: string | null; automations: { catalog_key: string } }[]
      | null) ?? []

  // "Recovered N bookings": distinct touched leads that are now booked.
  const touchedLeadIds = [...new Set(runs.map((r) => r.lead_id).filter((x): x is string => Boolean(x)))]
  const bookedLeads = new Set<string>()
  if (touchedLeadIds.length > 0) {
    const { data: leadData } = await supabase
      .from("leads")
      .select("id, stage, status")
      .in("id", touchedLeadIds)
    for (const l of (leadData as { id: string; stage: string | null; status: string }[] | null) ?? []) {
      if ((l.stage ?? "") === "booked" || l.status === "booked") bookedLeads.add(l.id)
    }
  }

  return AUTOMATION_CATALOG.map((entry) => {
    const config = configs.get(entry.key)!
    const mine = runs.filter((r) => r.automations.catalog_key === entry.key)
    return {
      key: entry.key,
      sentence: entry.sentence,
      detail: entry.detail,
      enabled: config.enabled,
      mode: config.mode,
      autopilotAllowed: isAutomationAutopilotAllowed(entry.key),
      template: config.template,
      defaultTemplate: entry.defaultTemplate,
      stats: {
        sent: mine.filter((r) => r.status === "sent").length,
        staged: mine.filter((r) => r.status === "staged").length,
        recoveredBookings: [
          ...new Set(mine.map((r) => r.lead_id).filter((x): x is string => Boolean(x))),
        ].filter((id) => bookedLeads.has(id)).length,
      },
    }
  })
}

const saveSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["approval", "autopilot"]),
  template: z.string().max(600),
})

export type SaveAutomationResult = { ok: true } | { ok: false; error: string }

export async function saveAutomation(
  key: AutomationCatalogKey,
  input: z.infer<typeof saveSchema>
): Promise<SaveAutomationResult> {
  if (!AUTOMATION_KEYS.includes(key)) return { ok: false, error: "Unknown automation." }
  const parsed = saveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." }
  }
  // HARD FLOOR (C5): money/calendar entries can never be autopilot — the
  // server rejects it no matter what the UI sent.
  if (parsed.data.mode === "autopilot" && !isAutomationAutopilotAllowed(key)) {
    return { ok: false, error: "This one always needs your approval — it touches money or the calendar." }
  }

  const shop = await requireShop()
  await requireUser()
  const supabase = await createClient()

  const id = await ensureAutomationRow(supabase, shop.id, key, {
    enabled: parsed.data.enabled,
    mode: parsed.data.mode,
  })
  if (!id) {
    return { ok: false, error: "Automations aren't available yet (is the C1 migration applied?)" }
  }
  const entry = AUTOMATION_CATALOG.find((e) => e.key === key)!
  const templateOverride =
    parsed.data.template.trim() && parsed.data.template.trim() !== entry.defaultTemplate.trim()
      ? parsed.data.template.trim()
      : null
  const { error } = await supabase
    .from("automations")
    .update({
      enabled: parsed.data.enabled,
      mode: parsed.data.mode,
      template_overrides: templateOverride ? { sms: templateOverride } : {},
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("shop_id", shop.id)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/settings")
  return { ok: true }
}
