"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { readAutonomy, type AutonomyConfig, type AutonomyMode } from "@/lib/autonomy"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

const modeSchema = z.enum(["suggest", "autonomous"])
const keySchema = z.string().trim().min(1).max(64)

export type AutonomyResult = { ok: true } | { ok: false; error: string }

async function loadSettings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  shopId: string
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shopId)
    .single()
  return (
    ((data as { settings: Record<string, unknown> | null } | null)?.settings) ??
    {}
  )
}

async function writeAutonomy(
  shopId: string,
  next: AutonomyConfig
): Promise<AutonomyResult> {
  const supabase = await createClient()
  const settings = await loadSettings(supabase, shopId)
  const { error } = await supabase
    .from("shops")
    .update({ settings: { ...settings, autonomy: next } })
    .eq("id", shopId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings")
  revalidatePath("/agents")
  return { ok: true }
}

async function currentConfig(shopId: string): Promise<AutonomyConfig> {
  const supabase = await createClient()
  const settings = await loadSettings(supabase, shopId)
  return readAutonomy({ settings } as ShopRow)
}

/** Global default new agents inherit. */
export async function setAutonomyDefault(
  mode: AutonomyMode
): Promise<AutonomyResult> {
  await requireUser()
  const shop = await requireShop()
  const parsed = modeSchema.safeParse(mode)
  if (!parsed.success) return { ok: false, error: "Unknown mode." }
  const cfg = await currentConfig(shop.id)
  return writeAutonomy(shop.id, { ...cfg, default: parsed.data })
}

/** Per-agent override. Pass mode=null-equivalent by clearing — here we just set. */
export async function setAgentMode(
  agentKey: string,
  mode: AutonomyMode
): Promise<AutonomyResult> {
  await requireUser()
  const shop = await requireShop()
  const key = keySchema.safeParse(agentKey)
  const m = modeSchema.safeParse(mode)
  if (!key.success || !m.success) return { ok: false, error: "Bad request." }
  const cfg = await currentConfig(shop.id)
  return writeAutonomy(shop.id, {
    ...cfg,
    overrides: { ...cfg.overrides, [key.data]: m.data },
  })
}
