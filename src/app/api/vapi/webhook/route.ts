/**
 * Vapi voice receptionist webhook.
 *
 * Vapi handles telephony, STT, and TTS; this endpoint is the bridge into
 * Gradia's brain. Two events matter:
 *
 *   - `function-call` — the assistant invoked a tool. Dispatched by name
 *     to handlers in lib/vapi-tools.ts. Available tools:
 *       capture_lead, propose_booking, quote_service, lookup_customer_history.
 *
 *   - `end-of-call-report` — when the call ends, every turn lands in the
 *     `interactions` table with channel="voice" so future calls (or other
 *     channels) can recall this conversation via the shared memory layer.
 *
 * Multi-tenancy: Vapi has no concept of a Gradia shop. For MVP, the shop
 * is resolved from the VAPI_DEFAULT_SHOP_ID env var (single-shop dev
 * mode). When we onboard multiple shops to Vapi, the natural extension
 * is to route by `message.assistant.id` — leave that to its own PR.
 *
 * Vapi assistant must be configured with:
 *   - Server URL = https://<your-public-url>/api/vapi/webhook
 *   - Server URL Secret = VAPI_WEBHOOK_SECRET (sent as x-vapi-secret)
 *   - Server events at minimum: function-call, end-of-call-report
 *   - System prompt should reflect HUMAN.md tone (we/us, partner voice)
 *   - Tools (declare each as a function in the Vapi assistant config):
 *
 *     capture_lead — log a general inquiry
 *       { customer_name: string, phone?: string,
 *         vehicle?: string, service?: string, notes?: string }
 *
 *     propose_booking — log an agreed-upon booking request
 *       { customer_name: string, phone?: string,
 *         service: string, when: string,
 *         vehicle?: string, notes?: string }
 *
 *     quote_service — read the shop's service menu
 *       { service: string }
 *
 *     lookup_customer_history — recall recent touchpoints
 *       { phone?: string }
 */

import { timingSafeEqual } from "node:crypto"
import { revalidatePath } from "next/cache"
import type { SupabaseClient } from "@supabase/supabase-js"

import { findOrCreateCustomer } from "@/lib/customers"
import { recordInteraction } from "@/lib/memory"
import { createServiceClient } from "@/lib/supabase/service"
import type { InteractionRole } from "@/lib/types/database"
import {
  captureLead,
  lookupCustomerHistory,
  proposeBooking,
  quoteService,
  type VapiCallContext,
} from "@/lib/vapi-tools"

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

function callContextFrom(message: VapiMessage): VapiCallContext {
  const callerPhone =
    asString(message.call?.customer?.number).trim() ||
    asString(message.call?.phoneNumber?.number).trim() ||
    undefined
  const callerName = asString(message.call?.customer?.name).trim() || undefined
  return {
    id: message.call?.id,
    callerPhone,
    callerName,
  }
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

  const ctx = callContextFrom(message)
  const params = fn.parameters ?? {}

  switch (fn.name) {
    case "capture_lead":
      return Response.json({
        result: await captureLead(supabase, shopId, params, ctx),
      })
    case "propose_booking":
      return Response.json({
        result: await proposeBooking(supabase, shopId, params, ctx),
      })
    case "quote_service":
      return Response.json({
        result: await quoteService(supabase, shopId, params, ctx),
      })
    case "lookup_customer_history":
      return Response.json({
        result: await lookupCustomerHistory(supabase, shopId, params, ctx),
      })
    default:
      return Response.json({ result: `Unknown function: ${fn.name}` })
  }
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
