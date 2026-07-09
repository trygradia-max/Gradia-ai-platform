/**
 * Voice provider seam — the vendor-neutral surface for the voice
 * receptionist (TELEPHONY_VOICE_BUILDER_SPEC Phase 2).
 *
 * Locked principle: ALL Vapi calls go through this seam (lib/vapi.ts is
 * the Vapi implementation detail behind it); no Vapi types or endpoints
 * leak past this module. This is the vendor-swap point for the deferred
 * "own the voice stack" decision — the seam IS the investment in that
 * option, so don't simplify it away.
 *
 * Composition rule: the system prompt is composed here, server-side, from
 * persona.ts (via vapi-prompt synthesis) + the shop's services + knowledge
 * + the builder form's voice_config. Owners never write prompts.
 */

import { randomBytes } from "node:crypto"

import type { SupabaseClient } from "@supabase/supabase-js"

import { encryptSecret, tryDecryptSecret } from "@/lib/crypto"
import { listShopKnowledge } from "@/lib/knowledge"
import { PLAN } from "@/lib/pricing"
import {
  createAssistant,
  createOutboundCall,
  findVoiceOption,
  importTwilioNumber,
  updateAssistant,
  VAPI_TOOL_DEFINITIONS,
  VAPI_VOICE_OPTIONS,
} from "@/lib/vapi"
import {
  synthesizeFirstMessage,
  synthesizeSystemPrompt,
  type SynthesisInput,
} from "@/lib/vapi-prompt"
import { formatWorkingHours, readWorkingHours } from "@/lib/working-hours"
import {
  getIncomingPhoneNumberConfig,
  setNumberSmsWebhook,
} from "@/lib/twilio"
import type {
  ServiceRow,
  ShopKnowledgeRow,
  ShopRow,
  VoiceConfig,
} from "@/lib/types/database"

// ---------- Curated surface (re-exported through the seam) ----------

/** The receptionist's declared tool surface — exposed for tests/audit. */
export { VAPI_TOOL_DEFINITIONS as VOICE_TOOL_DEFINITIONS }

export type CuratedVoice = { id: string; label: string; description: string }

/** The 3–5 curated voices the builder form offers (never the full vendor
 *  catalog). Vendor-specific routing stays behind the seam. */
export function listVoiceOptions(): CuratedVoice[] {
  return VAPI_VOICE_OPTIONS.map((v) => ({
    id: v.id,
    label: v.label,
    description: v.description,
  }))
}

// ---------- Composition ----------

export type ComposedAssistant = {
  name: string
  systemPrompt: string
  firstMessage: string
  /** Gradia-curated voice id (e.g. "warm-female"). */
  voice: string
}

/**
 * Pure composition: shop data + builder form → the assistant definition.
 * Exported separately so the builder UI can render the read-only
 * "What your receptionist knows" preview from the exact same source.
 */
export function composeVoiceAssistant(input: {
  shop: Pick<ShopRow, "name" | "location" | "phone">
  config: VoiceConfig
  services: ServiceRow[]
  knowledge: ShopKnowledgeRow[]
  /** Structured working-hours line (lib/working-hours) — used only when the
   *  owner hasn't written custom hours text, so voice and calendar agree. */
  fallbackHoursText?: string | null
}): ComposedAssistant {
  const config: VoiceConfig =
    !input.config.hours_text?.trim() && input.fallbackHoursText?.trim()
      ? { ...input.config, hours_text: input.fallbackHoursText.trim() }
      : input.config
  const synth: SynthesisInput = {
    shop: {
      name: input.shop.name,
      location: input.shop.location,
      phone: input.shop.phone,
      greeting: config.greeting ?? null,
      tone: config.tone ?? null,
    },
    services: input.services,
    knowledge: input.knowledge,
    config,
  }
  return {
    name: `${input.shop.name ?? "Gradia"} — voice receptionist`,
    systemPrompt: synthesizeSystemPrompt(synth),
    firstMessage: synthesizeFirstMessage(synth),
    voice: findVoiceOption(input.config.voice).id,
  }
}

// ---------- Assistant lifecycle ----------

type VoiceShopFields = Pick<
  ShopRow,
  | "id"
  | "name"
  | "location"
  | "phone"
  | "voice_config"
  | "vapi_assistant_id"
  | "vapi_server_secret_enc"
  | "vapi_phone_number_id"
  | "voice_test_called_at"
  | "gradia_number_e164"
  | "gradia_number_sid"
  | "twilio_subaccount_sid"
  | "twilio_subaccount_token_enc"
  | "settings"
>

export type SyncAssistantResult =
  | { ok: true; assistantId: string }
  | { ok: false; error: string }

/**
 * Composes from current shop data and creates (first save) or PATCHes
 * (edits, staleness sync) the assistant. Ensures the per-shop webhook
 * secret exists — generated once, encrypted at rest, sent to the vendor
 * so every callback carries it. Clears vapi_stale on success: this is
 * the sync the "voice never drifts from chat" rule rides on.
 */
/**
 * Take-a-message-only composition for a shop over its minute budget —
 * the spec's "after-hours fallback" fail-closed behavior. Voice can't be
 * cut mid-call, so this is how the NEXT call gets refused: the assistant
 * answers, explains, captures a message, and ends.
 */
function composeBudgetFallback(
  shop: Pick<ShopRow, "name">
): Pick<ComposedAssistant, "systemPrompt" | "firstMessage"> {
  const shopName = shop.name?.trim() || "the shop"
  return {
    firstMessage: `Thanks for calling ${shopName} — we can't take a full call right now, but I can take a message and we'll get right back to you.`,
    systemPrompt: [
      `You are the AI receptionist for ${shopName}. The shop is temporarily not taking full calls.`,
      "Take the caller's name, number, vehicle, and what they need, then use the capture_lead tool so the team follows up. Keep it under a minute.",
      "Do not quote prices, propose bookings, or answer policy questions on this call — just take the message warmly and promise a same-day callback.",
    ].join("\n"),
  }
}

export async function syncVoiceAssistant(input: {
  supabase: SupabaseClient
  shop: VoiceShopFields & Pick<ShopRow, "voice_addon" | "voice_minutes_budget">
  origin: string
}): Promise<SyncAssistantResult> {
  const { supabase, shop, origin } = input

  // Per-shop webhook secret (skill hard rule) — create once.
  let secret = tryDecryptSecret(shop.vapi_server_secret_enc)
  if (!secret) {
    secret = randomBytes(24).toString("hex")
    const { error } = await supabase
      .from("shops")
      .update({ vapi_server_secret_enc: encryptSecret(secret) })
      .eq("id", shop.id)
    if (error) {
      console.error("[voice] secret persist failed:", error)
      return { ok: false, error: "Couldn't prepare the receptionist — try again." }
    }
  }

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
    config: shop.voice_config ?? {},
    services: (serviceRows as ServiceRow[] | null) ?? [],
    knowledge,
    fallbackHoursText: formatWorkingHours(readWorkingHours(shop.settings)),
  })

  // Fail closed at the minute allowance, and when the voice add-on is
  // off (volume-gated, never mid-call): such shops get the take-a-message
  // fallback PATCHed in; the next sync after the month rolls, a pack is
  // bought, or the add-on returns restores the full receptionist.
  const budget = await voiceBudgetState(supabase, shop)
  const effective =
    budget.over || !shop.voice_addon
      ? { ...composed, ...composeBudgetFallback(shop) }
      : composed

  const body = {
    name: composed.name,
    firstMessage: effective.firstMessage,
    systemPrompt: effective.systemPrompt,
    serverUrl: `${origin}/api/vapi/webhook`,
    serverSecret: secret,
    voice: findVoiceOption(composed.voice).id,
    shopId: shop.id,
  }

  try {
    const existing = shop.vapi_assistant_id?.trim() || null
    const assistant = existing
      ? await updateAssistant(existing, body)
      : await createAssistant(body)

    const { error } = await supabase
      .from("shops")
      .update({ vapi_assistant_id: assistant.id, vapi_stale: false })
      .eq("id", shop.id)
    if (error) {
      console.error("[voice] assistant persist failed:", error)
      return { ok: false, error: "Couldn't save the receptionist — try again." }
    }
    return { ok: true, assistantId: assistant.id }
  } catch (err) {
    console.error("[voice] assistant sync failed:", err)
    return {
      ok: false,
      error: "The voice service rejected the update — try again shortly.",
    }
  }
}

/**
 * Marks a shop's assistant stale so the hourly sync re-composes it.
 * Call from anything that changes what the receptionist should know:
 * knowledge edits, service menu changes, persona updates.
 */
export async function markVoiceStale(
  supabase: SupabaseClient,
  shopId: string
): Promise<void> {
  const { error } = await supabase
    .from("shops")
    .update({ vapi_stale: true })
    .eq("id", shopId)
    .not("vapi_assistant_id", "is", null)
  if (error) console.error("[voice] markVoiceStale failed:", error)
}

// ---------- Number attachment ----------

export type AttachNumberResult =
  | { ok: true; phoneNumberId: string }
  | { ok: false; error: string }

/**
 * Routes inbound VOICE on the shop's Gradia number to the assistant.
 * SMS keeps routing to Gradia: the import passes smsEnabled:false (spike
 * #2 finding), and we verify the Twilio messaging webhook afterwards,
 * re-pointing it if the vendor clobbered it anyway.
 */
export async function attachVoiceNumber(input: {
  supabase: SupabaseClient
  shop: VoiceShopFields
  origin: string
}): Promise<AttachNumberResult> {
  const { supabase, shop, origin } = input

  if (!shop.vapi_assistant_id) {
    return { ok: false, error: "Save the receptionist first." }
  }
  if (!shop.gradia_number_e164 || !shop.gradia_number_sid) {
    return { ok: false, error: "Buy a business number first — voice attaches to it." }
  }
  const subToken = tryDecryptSecret(shop.twilio_subaccount_token_enc)
  if (!shop.twilio_subaccount_sid || !subToken) {
    return { ok: false, error: "This number isn't on a Gradia phone account — contact support." }
  }
  const creds = { accountSid: shop.twilio_subaccount_sid, authToken: subToken }

  try {
    const before = await getIncomingPhoneNumberConfig({
      sid: shop.gradia_number_sid,
      creds,
    })

    const { phoneNumberId } = await importTwilioNumber({
      e164: shop.gradia_number_e164,
      twilioAccountSid: creds.accountSid,
      twilioAuthToken: creds.authToken,
      assistantId: shop.vapi_assistant_id,
      name: `${shop.name} — Gradia`,
    })

    // Belt and braces on the voice/SMS split: if the import touched the
    // messaging webhook despite smsEnabled:false, put it back.
    const expectedSmsUrl = before?.smsUrl || `${origin}/api/twilio/sms`
    const after = await getIncomingPhoneNumberConfig({
      sid: shop.gradia_number_sid,
      creds,
    })
    if (after && after.smsUrl !== expectedSmsUrl) {
      console.warn("[voice] Vapi import changed SmsUrl — re-setting", {
        before: expectedSmsUrl,
        after: after.smsUrl,
      })
      await setNumberSmsWebhook({
        sid: shop.gradia_number_sid,
        smsUrl: expectedSmsUrl,
        creds,
      })
    }

    const { error } = await supabase
      .from("shops")
      .update({ vapi_phone_number_id: phoneNumberId })
      .eq("id", shop.id)
    if (error) {
      console.error("[voice] phone-number persist failed:", error)
      return { ok: false, error: "Couldn't save the connection — try again." }
    }
    return { ok: true, phoneNumberId }
  } catch (err) {
    console.error("[voice] number attach failed:", err)
    return {
      ok: false,
      error: "Couldn't connect the number to voice — try again shortly.",
    }
  }
}

// ---------- Test call + launch gate ----------

export type TestCallResult = { ok: true } | { ok: false; error: string }

/** Rings the owner from their business number with the assistant live —
 *  the launch-gate test. Marks voice_test_called_at on success. */
export async function startVoiceTestCall(input: {
  supabase: SupabaseClient
  shop: VoiceShopFields
  toNumber: string
}): Promise<TestCallResult> {
  const { supabase, shop, toNumber } = input
  if (!shop.vapi_assistant_id || !shop.vapi_phone_number_id) {
    return { ok: false, error: "Connect the number to voice first." }
  }
  try {
    await createOutboundCall({
      assistantId: shop.vapi_assistant_id,
      phoneNumberId: shop.vapi_phone_number_id,
      toNumber,
    })
    await supabase
      .from("shops")
      .update({ voice_test_called_at: new Date().toISOString() })
      .eq("id", shop.id)
    return { ok: true }
  } catch (err) {
    console.error("[voice] test call failed:", err)
    return { ok: false, error: "Couldn't place the test call — try again." }
  }
}

export type LaunchGate = {
  ready: boolean
  missing: ("number" | "assistant" | "test_call")[]
}

/** Launch prerequisites (spec §2.4) — pure so the UI and the action share
 *  one truth. */
export function voiceLaunchGate(
  shop: Pick<
    ShopRow,
    "vapi_assistant_id" | "vapi_phone_number_id" | "voice_test_called_at"
  >
): LaunchGate {
  const missing: LaunchGate["missing"] = []
  if (!shop.vapi_phone_number_id) missing.push("number")
  if (!shop.vapi_assistant_id) missing.push("assistant")
  if (!shop.voice_test_called_at) missing.push("test_call")
  return { ready: missing.length === 0, missing }
}

// ---------- Minute budget (spec §2.5) ----------

export type VoiceBudgetState = {
  usedMinutes: number
  budget: number | null
  /** ≥80% of budget used. */
  warn: boolean
  /** ≥100% — fail closed: refuse the NEXT call (can't cut a live one). */
  over: boolean
}

/**
 * Calendar-month voice minutes vs the shop's minute allowance
 * (GRADIA_PRICING.md): 60 included with the voice add-on + 40 per minute
 * pack this month. The owner's voice_minutes_budget, when set lower, is
 * an additional cap. No add-on → allowance 0 → over (fail closed).
 * Warn at 80%, refuse the NEXT call at 100%.
 */
export async function voiceBudgetState(
  supabase: SupabaseClient,
  shop: Pick<ShopRow, "id" | "voice_addon" | "voice_minutes_budget">,
  now: Date = new Date()
): Promise<VoiceBudgetState> {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString()
  const [usageRes, grantsRes] = await Promise.all([
    supabase
      .from("usage_events")
      .select("quantity")
      .eq("shop_id", shop.id)
      .eq("kind", "voice_minute")
      .gte("created_at", monthStart),
    supabase
      .from("credit_grants")
      .select("minutes")
      .eq("shop_id", shop.id)
      .gte("created_at", monthStart),
  ])
  if (usageRes.error) {
    console.error("[voice] budget query failed:", usageRes.error)
    return { usedMinutes: 0, budget: null, warn: false, over: false }
  }
  const usedMinutes = (
    (usageRes.data as { quantity: number }[] | null) ?? []
  ).reduce((sum, r) => sum + (r.quantity ?? 0), 0)

  const grantedMinutes = grantsRes.error
    ? 0
    : ((grantsRes.data as { minutes: number }[] | null) ?? []).reduce(
        (sum, r) => sum + (r.minutes ?? 0),
        0
      )
  const allowance =
    (shop.voice_addon ? PLAN.VOICE_INCLUDED_MINUTES : 0) + grantedMinutes
  const ownerCap = shop.voice_minutes_budget
  const budget =
    ownerCap != null && ownerCap > 0 ? Math.min(allowance, ownerCap) : allowance

  return {
    usedMinutes,
    budget,
    warn: budget > 0 && usedMinutes >= budget * PLAN.WARN_FRACTION,
    over: usedMinutes >= budget,
  }
}
