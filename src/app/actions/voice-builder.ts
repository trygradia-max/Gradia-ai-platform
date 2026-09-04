"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { hasVoice } from "@/lib/entitlements"
import { listShopKnowledge } from "@/lib/knowledge"
import { TIER_ORDER, TIERS } from "@/lib/pricing"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  attachVoiceNumber,
  composeVoiceAssistant,
  startVoiceTestCall,
  syncVoiceAssistant,
  voiceLaunchGate,
} from "@/lib/voice-provider"
import type { ServiceRow, ShopRow, VoiceConfig } from "@/lib/types/database"

async function resolveOrigin(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

async function loadShop(): Promise<ShopRow | null> {
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  return (data as ShopRow | null) ?? null
}

/** The guardrailed builder form (spec §2.1) — never a prompt editor. */
const voiceConfigSchema = z.object({
  greeting: z.string().trim().max(200).nullable().or(z.literal("").transform(() => null)),
  tone: z.enum(["warm", "professional", "playful"]).nullable(),
  voice: z.string().trim().min(1),
  after_hours: z.enum(["message_only", "take_message"]).nullable(),
  hours_text: z.string().trim().max(200).nullable().or(z.literal("").transform(() => null)),
  booking_mode: z.enum(["propose_booking", "calendar_link"]).nullable(),
  calendar_link: z
    .string()
    .trim()
    .url("Booking link must be a full URL (https://…).")
    .nullable()
    .or(z.literal("").transform(() => null)),
  escalation_phone: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\+1\d{10}$/.test(v), "US phone in +1XXXXXXXXXX format.")
    .transform((v) => v || null)
    .nullable(),
})

export type VoiceConfigInput = z.input<typeof voiceConfigSchema>

/** Owner-facing copy for a tier without voice — tier names from PLAN (P0-013). */
function voiceNotIncludedError(): string {
  const withVoice = TIER_ORDER.filter((t) => TIERS[t].voice).map((t) => TIERS[t].label)
  return `The voice receptionist is included in ${withVoice.join(" and ")} — change plans in Billing first.`
}

export type SaveVoiceConfigResult =
  | { ok: true; assistantId: string }
  | { ok: false; error: string }

/** Persists the form and composes + creates/PATCHes the assistant. */
export async function saveVoiceConfig(
  input: VoiceConfigInput
): Promise<SaveVoiceConfigResult> {
  await requireUser()
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }
  if (!hasVoice(shop)) {
    return { ok: false, error: voiceNotIncludedError() }
  }

  const parsed = voiceConfigSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form and try again.",
    }
  }
  if (parsed.data.booking_mode === "calendar_link" && !parsed.data.calendar_link) {
    return { ok: false, error: "Add the booking link, or switch back to staged bookings." }
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("shops")
    .update({ voice_config: parsed.data as VoiceConfig })
    .eq("id", shop.id)
  if (error) return { ok: false, error: "Couldn't save — try again." }

  const result = await syncVoiceAssistant({
    supabase,
    shop: { ...shop, voice_config: parsed.data as VoiceConfig },
    origin: await resolveOrigin(),
  })
  if (result.ok) revalidatePath("/settings")
  return result
}

export type VoicePreview = {
  systemPrompt: string
  firstMessage: string
}

/** Read-only "What your receptionist knows" pane — composed from the SAME
 *  source as the live assistant, never editable. */
export async function getVoicePreview(
  input: VoiceConfigInput
): Promise<VoicePreview> {
  const shop = await loadShop()
  if (!shop) return { systemPrompt: "", firstMessage: "" }
  const parsed = voiceConfigSchema.safeParse(input)
  const config = parsed.success ? (parsed.data as VoiceConfig) : (shop.voice_config ?? {})

  const supabase = await createClient()
  const [{ data: serviceRows }, knowledge] = await Promise.all([
    supabase
      .from("services")
      .select("*")
      .eq("shop_id", shop.id)
      .order("created_at", { ascending: true }),
    listShopKnowledge(supabase, shop.id),
  ])
  const composed = composeVoiceAssistant({
    shop,
    config,
    services: (serviceRows as ServiceRow[] | null) ?? [],
    knowledge,
  })
  return { systemPrompt: composed.systemPrompt, firstMessage: composed.firstMessage }
}

export type ConnectVoiceNumberResult =
  | { ok: true }
  | { ok: false; error: string }

/** Routes inbound voice on the Gradia number to the assistant (SMS stays
 *  on Gradia — verified after import). */
export async function connectVoiceNumber(): Promise<ConnectVoiceNumberResult> {
  await requireUser()
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }
  const result = await attachVoiceNumber({
    supabase: createServiceClient(),
    shop,
    origin: await resolveOrigin(),
  })
  if (result.ok) revalidatePath("/settings")
  return result.ok ? { ok: true } : result
}

export type TestCallActionResult = { ok: true } | { ok: false; error: string }

const testCallSchema = z.object({
  toNumber: z
    .string()
    .trim()
    .refine((v) => /^\+1\d{10}$/.test(v), "US phone in +1XXXXXXXXXX format."),
})

/** Rings the owner with the receptionist live — the launch-gate test. */
export async function requestVoiceTestCall(input: {
  toNumber: string
}): Promise<TestCallActionResult> {
  await requireUser()
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }
  const parsed = testCallSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the number." }
  }
  const result = await startVoiceTestCall({
    supabase: createServiceClient(),
    shop,
    toNumber: parsed.data.toNumber,
  })
  if (result.ok) revalidatePath("/settings")
  return result
}

export type SetVoiceLiveResult = { ok: true } | { ok: false; error: string }

/** Launch toggle — gated on number + assistant + completed test call. */
export async function setVoiceLive(live: boolean): Promise<SetVoiceLiveResult> {
  await requireUser()
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }

  if (live) {
    if (!hasVoice(shop)) {
      return { ok: false, error: voiceNotIncludedError() }
    }
    const gate = voiceLaunchGate(shop)
    if (!gate.ready) {
      const labels: Record<string, string> = {
        number: "connect your business number",
        assistant: "save the receptionist",
        test_call: "do a test call",
      }
      return {
        ok: false,
        error: `Almost there — first ${gate.missing.map((m) => labels[m]).join(", then ")}.`,
      }
    }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from("shops")
    .update({ voice_live: live })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings")
  return { ok: true }
}

const budgetSchema = z.object({
  minutes: z.number().int().min(0).max(100_000).nullable(),
})

export type SaveVoiceBudgetResult = { ok: true } | { ok: false; error: string }

/** Owner-set monthly voice-minute cap (spec §2.5). Null = no cap. */
export async function saveVoiceMinutesBudget(
  minutes: number | null
): Promise<SaveVoiceBudgetResult> {
  await requireUser()
  const shop = await requireShop()
  const parsed = budgetSchema.safeParse({ minutes })
  if (!parsed.success) {
    return { ok: false, error: "Enter a whole number of minutes (or clear for no cap)." }
  }
  const supabase = await createClient()
  const { error } = await supabase
    .from("shops")
    .update({ voice_minutes_budget: parsed.data.minutes })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings")
  return { ok: true }
}
