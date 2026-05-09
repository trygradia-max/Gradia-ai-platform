/**
 * Vapi voice receptionist webhook.
 *
 * Vapi handles telephony, STT, and TTS; this endpoint is the bridge into
 * Gradia's brain. Two events matter for MVP:
 *
 *   - `function-call` — the assistant invoked a tool. We dispatch on
 *     functionCall.name. The only tool right now is `capture_lead`, which
 *     creates a pending_action and posts a Slack approval card (same HITL
 *     gate the dashboard uses).
 *
 *   - `end-of-call-report` — when the call ends, every turn lands in the
 *     `interactions` table with channel="voice" so future calls (or other
 *     channels) can recall this conversation via the shared memory layer.
 *
 * Multi-tenancy: Vapi has no concept of a Gradia shop. For MVP, the shop
 * is resolved from the VAPI_DEFAULT_SHOP_ID env var (single-shop dev
 * mode). When we onboard multiple shops to Vapi, the natural extension
 * is to route by `message.assistant.id` (each shop's Vapi assistant
 * gets a unique id) — leave that to its own PR.
 *
 * Vapi assistant must be configured with:
 *   - Server URL = https://<your-public-url>/api/vapi/webhook
 *   - Server URL Secret = VAPI_WEBHOOK_SECRET (sent as x-vapi-secret)
 *   - Function tool `capture_lead` with parameters:
 *       customer_name (string, required)
 *       phone (string, required)  — defaults to caller ID if absent
 *       vehicle (string, optional)
 *       service (string, optional)
 *       notes (string, optional)
 *   - System prompt should reflect HUMAN.md tone (we/us, partner voice)
 */

import { timingSafeEqual } from "node:crypto"
import { revalidatePath } from "next/cache"
import type { SupabaseClient } from "@supabase/supabase-js"

import { findOrCreateCustomer } from "@/lib/customers"
import { recordInteraction } from "@/lib/memory"
import { sendLeadApprovalRequest } from "@/lib/slack"
import { createServiceClient } from "@/lib/supabase/service"
import type { InteractionRole, LeadStatus } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type VapiCall = {
  id?: string
  customer?: { number?: string; name?: string }
  phoneNumber?: { number?: string }
  assistantId?: string
}

type VapiTurn = {
  role?: string
  message?: string
  content?: string
  time?: number
  endTime?: number
}

type VapiMessage = {
  type?: string
  call?: VapiCall
  functionCall?: {
    name?: string
    parameters?: Record<string, unknown>
  }
  messages?: VapiTurn[]
  transcript?: string
  endedReason?: string
  summary?: string
  recordingUrl?: string
}

type VapiPayload = { message?: VapiMessage }

function verifyVapiSecret(request: Request): boolean {
  const expected = process.env.VAPI_WEBHOOK_SECRET?.trim()
  if (!expected) return false
  const provided = request.headers.get("x-vapi-secret")
  if (!provided) return false

  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function resolveShopId(): string | null {
  return process.env.VAPI_DEFAULT_SHOP_ID?.trim() || null
}

function asString(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return String(value)
}

export async function POST(request: Request) {
  if (!verifyVapiSecret(request)) {
    return new Response("Invalid signature", { status: 401 })
  }

  const shopId = resolveShopId()
  if (!shopId) {
    console.error("[vapi] VAPI_DEFAULT_SHOP_ID not configured")
    return new Response("Server not configured", { status: 500 })
  }

  let payload: VapiPayload
  try {
    payload = (await request.json()) as VapiPayload
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  const message = payload.message
  if (!message?.type) {
    return new Response("Missing message.type", { status: 400 })
  }

  const supabase = createServiceClient()

  switch (message.type) {
    case "function-call":
      return handleFunctionCall(supabase, shopId, message)
    case "end-of-call-report":
      return handleEndOfCall(supabase, shopId, message)
    default:
      // status-update, transcript chunks, hang, etc — ack and ignore for MVP
      return Response.json({ ok: true })
  }
}

async function handleFunctionCall(
  supabase: SupabaseClient,
  shopId: string,
  message: VapiMessage
): Promise<Response> {
  const fn = message.functionCall
  if (!fn?.name) {
    return Response.json({ result: "No function specified." })
  }

  switch (fn.name) {
    case "capture_lead": {
      const result = await captureLeadFromVoice(
        supabase,
        shopId,
        fn.parameters ?? {},
        message.call
      )
      return Response.json({ result })
    }
    default:
      return Response.json({ result: `Unknown function: ${fn.name}` })
  }
}

/**
 * Vapi tool handler — creates a pending_action proposal and fires Slack
 * approval. Returns a string the assistant will speak back to the caller.
 */
async function captureLeadFromVoice(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  call: VapiCall | undefined
): Promise<string> {
  const customerName = asString(
    params.customer_name ?? params.customerName
  ).trim()
  const phone = (
    asString(params.phone).trim() ||
    asString(call?.customer?.number).trim() ||
    asString(call?.phoneNumber?.number).trim()
  )
  const vehicle =
    asString(params.vehicle ?? params.car_info ?? params.carInfo).trim() ||
    null
  const service = asString(params.service).trim() || null
  const noteParam = asString(params.notes ?? params.note).trim() || null

  if (!customerName || !phone) {
    return "I couldn't catch the name and phone — could we try those one more time?"
  }

  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("owner_id")
    .eq("id", shopId)
    .single()

  if (shopErr || !shop?.owner_id) {
    console.error("[vapi] shop owner not found for", shopId, shopErr)
    return "I'm having trouble saving that on our end — let me have someone call you back."
  }

  const pinNotes =
    [service && `Requested: ${service}`, noteParam]
      .filter((s): s is string => Boolean(s))
      .join(" — ") || null

  const proposal = {
    customer_name: customerName,
    phone,
    car_info: vehicle,
    pin_notes: pinNotes,
    status: "new" as LeadStatus,
    source: "voice",
    vapi_call_id: call?.id ?? null,
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shopId,
      action_type: "create_lead",
      payload: proposal,
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error("[vapi] could not create pending_action:", pendingErr)
    return "Something went wrong on our end — let me have someone follow up."
  }

  try {
    await sendLeadApprovalRequest({
      pendingActionId: pending.id,
      customerName,
      phone,
      carInfo: vehicle,
      pinNotes,
      status: "new",
    })
  } catch (slackErr) {
    console.error("[vapi] Slack approval send failed:", slackErr)
  }

  revalidatePath("/approvals")

  const firstName = customerName.split(/\s+/)[0] ?? customerName
  return `Got it, ${firstName} — we'll confirm shortly and text you the details.`
}

/**
 * Persists every turn of the call into the shared memory layer so future
 * touchpoints across any channel can recall this conversation.
 */
async function handleEndOfCall(
  supabase: SupabaseClient,
  shopId: string,
  message: VapiMessage
): Promise<Response> {
  const callerPhone =
    asString(message.call?.customer?.number).trim() ||
    asString(message.call?.phoneNumber?.number).trim() ||
    null

  let customerId: string | null = null
  if (callerPhone) {
    const result = await findOrCreateCustomer(supabase, shopId, {
      phone: callerPhone,
      name: asString(message.call?.customer?.name).trim() || null,
    })
    if (result.ok) {
      customerId = result.customer.id
    } else {
      console.warn(
        "[vapi] customer resolve failed, ingesting without customer_id:",
        result.error
      )
    }
  }

  const turns = message.messages ?? []
  for (const turn of turns) {
    const content = (asString(turn.message) || asString(turn.content)).trim()
    if (!content) continue

    const role: InteractionRole =
      turn.role === "user"
        ? "customer"
        : turn.role === "assistant"
          ? "gradia"
          : "system"

    const result = await recordInteraction(supabase, {
      shopId,
      customerId,
      channel: "voice",
      role,
      content,
      metadata: {
        vapi_call_id: message.call?.id ?? null,
        ended_reason: message.endedReason ?? null,
        recording_url: message.recordingUrl ?? null,
      },
    })

    if (!result.ok) {
      console.error("[vapi] recordInteraction failed:", result.error)
    }
  }

  revalidatePath("/dashboard")
  revalidatePath("/leads")
  revalidatePath("/approvals")

  return Response.json({ ok: true, turnsIngested: turns.length })
}
