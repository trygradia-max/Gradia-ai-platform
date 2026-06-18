/**
 * Gradia Whisper processing endpoint — voice into the SAME engine as the typed
 * Gradia Agent box (one engine, two modalities; FOCUS spec NOW-2).
 *
 *   1. Authenticate + fail-closed credit/burst gates
 *   2. Transcribe via OpenAI Whisper
 *   3. Route the transcript through `streamOwnerAgent` — the same intent router
 *      and action registry the typed box uses (no second engine, no second
 *      intent parser).
 *   4. Return the agent's reply for the UI to read back.
 *
 * Approval gradient is enforced by the engine's tools: capture/data edits
 * (add_note, create_lead, update_customer) execute immediately; outbound
 * (draft_reply, campaigns) stages to /approvals; booking/money is ALWAYS_HITL.
 * The loop has NO send tool — Whisper stages, never sends.
 */

import { revalidatePath } from "next/cache"

import type { ChatMessage } from "@/lib/bi-agent"
import {
  checkFeatureAccess,
  loadShopCreditFields,
  recordUsage,
} from "@/lib/credits"
import { streamOwnerAgent } from "@/lib/owner-agent"
import { getPricing, priceUsage } from "@/lib/pricing"
import { checkRateLimit } from "@/lib/rate-limit"
import { getOptionalShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"
import { transcribeAudio } from "@/lib/whisper"
import type { SupabaseClient } from "@supabase/supabase-js"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Transcription (Whisper) + the routing turn (Sonnet) can exceed Vercel's 10s
// Hobby default. 60s is the Hobby max — plenty for a single voice command.
export const maxDuration = 60

const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // OpenAI Whisper file-size limit

type WhisperResult =
  | { ok: true; transcript: string; reply: string; tools: string[] }
  | { ok: false; error: string; transcript?: string }

function jsonResult(result: WhisperResult, status = 200): Response {
  return Response.json(result, { status })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return jsonResult({ ok: false, error: "Sign-in expired — refresh and try again." }, 401)
  }

  const shop = await getOptionalShop()
  if (!shop) {
    return jsonResult({ ok: false, error: "We need to set up our shop first." }, 403)
  }

  // Fail-closed: an inactive plan or an exhausted credit balance shuts Whisper
  // off before we spend a cent on transcription.
  const creditFields = await loadShopCreditFields(supabase, shop.id)
  if (!creditFields) {
    return jsonResult({ ok: false, error: "We need to set up our shop first." }, 403)
  }
  const access = await checkFeatureAccess(supabase, creditFields)
  if (!access.ok) {
    return jsonResult({ ok: false, error: access.reason }, access.status)
  }

  const burst = await checkRateLimit(shop.id, "whisper")
  if (!burst.allowed) {
    return jsonResult(
      { ok: false, error: "Give us a second to catch up — try again shortly." },
      429
    )
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return jsonResult({ ok: false, error: "Couldn't read upload." }, 400)
  }

  const file = formData.get("audio")
  if (!(file instanceof File)) {
    return jsonResult({ ok: false, error: "No audio attached." }, 400)
  }
  if (file.size === 0) {
    return jsonResult({ ok: false, error: "Didn't hear anything — try again." }, 400)
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return jsonResult({ ok: false, error: "Recording too long — keep it under 25 MB." }, 400)
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  let transcript: string
  try {
    transcript = await transcribeAudio(
      buffer,
      file.name || "recording.webm",
      file.type || "audio/webm"
    )
  } catch (err) {
    console.error("[whisper] transcribe failed:", err)
    return jsonResult({ ok: false, error: "Couldn't catch that — give us another shot." }, 500)
  }

  if (!transcript) {
    return jsonResult({ ok: false, error: "Didn't hear anything — try again." }, 400)
  }

  // The action tools need the full shop row (RLS-scoped to the owner).
  const { data: shopRow, error: shopErr } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shop.id)
    .single()
  if (shopErr || !shopRow) {
    return jsonResult({ ok: false, error: "Couldn't load the shop.", transcript }, 500)
  }

  // Route the transcript through the SAME owner-agent engine the typed box uses.
  // It classifies intent, executes capture immediately, stages outbound, and
  // refuses out-of-registry asks — all already built. Whisper never sends.
  const history: ChatMessage[] = [{ role: "user", content: transcript }]
  let reply = ""
  const tools: string[] = []
  try {
    for await (const ev of streamOwnerAgent({
      supabase,
      shop: shopRow as ShopRow,
      ownerId: user.id,
      history,
    })) {
      if (ev.type === "text_delta") reply += ev.text
      else if (ev.type === "tool_start") tools.push(ev.name)
      else if (ev.type === "error") reply += `\n${ev.message}`
    }
  } catch (err) {
    console.error("[whisper] agent routing failed:", err)
    return jsonResult({ ok: false, error: "Couldn't act on that — try again.", transcript }, 500)
  }

  await meterWhisperNote(supabase, shop.id)
  revalidatePath("/approvals")
  revalidatePath("/customers")
  return jsonResult({ ok: true, transcript, reply: reply.trim(), tools })
}

/** Locked menu: 3 credits per Whisper turn (owner-initiated; staged drafts the
 *  turn produces are metered separately by the stage tool). */
async function meterWhisperNote(
  supabase: SupabaseClient,
  shopId: string
): Promise<void> {
  const priced = priceUsage(await getPricing(supabase), "whisper_note", 1)
  await recordUsage(supabase, shopId, "whisper_note", {
    credits: priced.credits,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
  })
}
