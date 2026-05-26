"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

import { listShopKnowledge } from "@/lib/knowledge"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type {
  ServiceRow,
  ShopRow,
} from "@/lib/types/database"
import {
  createAssistant,
  deleteAssistant as deleteVapiAssistantApi,
  findVoiceOption,
  updateAssistant,
  VAPI_VOICE_OPTIONS,
  type VapiVoiceId,
} from "@/lib/vapi"
import {
  synthesizeFirstMessage,
  synthesizeSystemPrompt,
  type SynthesisInput,
} from "@/lib/vapi-prompt"

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

async function loadShopAndServices(): Promise<{
  shop: ShopRow
  services: ServiceRow[]
} | null> {
  const shopCtx = await requireShop()
  const supabase = await createClient()

  const [{ data: shopRow }, { data: serviceRows }] = await Promise.all([
    supabase.from("shops").select("*").eq("id", shopCtx.id).single(),
    supabase
      .from("services")
      .select("*")
      .eq("shop_id", shopCtx.id)
      .order("created_at", { ascending: true }),
  ])

  const shop = (shopRow as ShopRow | null) ?? null
  if (!shop) return null
  return {
    shop,
    services: (serviceRows as ServiceRow[] | null) ?? [],
  }
}

export type BuildVapiAssistantResult =
  | { ok: true; assistantId: string }
  | { ok: false; error: string }

export type BuildVapiAssistantInput = {
  voice: VapiVoiceId
  greeting?: string | null
  tone?: "warm" | "professional" | "playful" | null
}

/**
 * Creates the assistant on Vapi (or replaces an existing one for this
 * shop) and persists its id on shops.vapi_assistant_id. The system
 * prompt is synthesized from the shop's actual services + knowledge —
 * operators don't write prompt engineering by hand.
 */
export async function buildVapiAssistant(
  input: BuildVapiAssistantInput
): Promise<BuildVapiAssistantResult> {
  if (!process.env.VAPI_API_KEY?.trim()) {
    return {
      ok: false,
      error: "Vapi isn't configured on the server yet.",
    }
  }

  const loaded = await loadShopAndServices()
  if (!loaded) {
    return { ok: false, error: "Finish onboarding first." }
  }

  const supabase = await createClient()
  const knowledge = await listShopKnowledge(supabase, loaded.shop.id)

  const synthInput: SynthesisInput = {
    shop: {
      name: loaded.shop.name,
      location: loaded.shop.location,
      phone: loaded.shop.phone,
      greeting: input.greeting ?? null,
      tone: input.tone ?? null,
    },
    services: loaded.services,
    knowledge,
  }

  const origin = await resolveOrigin()
  const serverUrl = `${origin}/api/vapi/webhook`

  const systemPrompt = synthesizeSystemPrompt(synthInput)
  const firstMessage = synthesizeFirstMessage(synthInput)
  const voice = findVoiceOption(input.voice)

  const assistantName = `${loaded.shop.name ?? "Gradia"} — voice receptionist`
  const existingAssistantId = loaded.shop.vapi_assistant_id?.trim() || null

  try {
    const assistant = existingAssistantId
      ? await updateAssistant(existingAssistantId, {
          name: assistantName,
          firstMessage,
          systemPrompt,
          serverUrl,
          voice: voice.id,
          shopId: loaded.shop.id,
        })
      : await createAssistant({
          name: assistantName,
          firstMessage,
          systemPrompt,
          serverUrl,
          voice: voice.id,
          shopId: loaded.shop.id,
        })

    if (assistant.id !== existingAssistantId) {
      const { error } = await supabase
        .from("shops")
        .update({ vapi_assistant_id: assistant.id })
        .eq("id", loaded.shop.id)
      if (error) {
        return {
          ok: false,
          error: "Couldn't save the assistant id — try again.",
        }
      }
    }

    revalidatePath("/settings")
    return { ok: true, assistantId: assistant.id }
  } catch (err) {
    console.error("[vapi-provision] build failed:", err)
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Vapi rejected the build — try again or check the server logs.",
    }
  }
}

export type RebuildVapiAssistantResult = BuildVapiAssistantResult

/**
 * Re-syncs the assistant's system prompt with the shop's current
 * services + knowledge. Use when the operator's added a new service or
 * pasted new policy text and wants the voice agent to know about it
 * without ripping it out and rebuilding from scratch.
 */
export async function rebuildVapiAssistant(input?: {
  voice?: VapiVoiceId
  greeting?: string | null
  tone?: "warm" | "professional" | "playful" | null
}): Promise<RebuildVapiAssistantResult> {
  return buildVapiAssistant({
    voice: input?.voice ?? "warm-female",
    greeting: input?.greeting ?? null,
    tone: input?.tone ?? null,
  })
}

export type DeleteVapiAssistantResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Deletes the assistant on Vapi and clears the id from the shop row.
 * Use only when the operator wants to wipe the receptionist entirely;
 * for soft disconnect (keep the assistant, just unwire it from the
 * shop) we still have the old saveVapiAssistantId({ vapi_assistant_id:
 * null }) path.
 */
export async function deleteVapiAssistant(): Promise<DeleteVapiAssistantResult> {
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("vapi_assistant_id")
    .eq("id", shopCtx.id)
    .single()
  const assistantId = (data as { vapi_assistant_id: string | null } | null)
    ?.vapi_assistant_id?.trim()
  if (!assistantId) {
    return { ok: false, error: "No assistant to delete." }
  }

  if (!process.env.VAPI_API_KEY?.trim()) {
    return {
      ok: false,
      error: "Vapi isn't configured on the server yet.",
    }
  }

  try {
    await deleteVapiAssistantApi(assistantId)
  } catch (err) {
    console.error("[vapi-provision] delete failed:", err)
    // If Vapi 404s we still clear the shop row — assistant's already gone.
  }

  const { error } = await supabase
    .from("shops")
    .update({ vapi_assistant_id: null })
    .eq("id", shopCtx.id)
  if (error) {
    return { ok: false, error: error.message }
  }
  revalidatePath("/settings")
  return { ok: true }
}

/** Re-export so the client form can render voice options without
 *  importing server-only Vapi internals. */
export async function listVoiceOptions() {
  return VAPI_VOICE_OPTIONS.map((v) => ({
    id: v.id,
    label: v.label,
    description: v.description,
  }))
}
