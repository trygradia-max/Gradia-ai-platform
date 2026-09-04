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
 *     Replay-safe (P0-007, ADR-001): the branch claims
 *     (provider='vapi', event_id=call.id) via provider_events strictly
 *     after signature verification and before any write, so provider
 *     retries produce zero duplicate transcript rows, zero duplicate
 *     voice-minute metering, and no repeated budget/call-record effects.
 *
 * Multi-tenancy: Vapi has no concept of a Gradia shop. The webhook
 * resolves the shop by matching `message.call.assistantId` against
 * `shops.vapi_assistant_id` (set in /settings → Voice receptionist).
 * `VAPI_DEFAULT_SHOP_ID` is kept as a single-shop dev fallback for
 * local testing without a real assistant configured.
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

import { persistCallRecord } from "@/lib/call-records"
import { recordUsage } from "@/lib/credits"
import { tryDecryptSecret } from "@/lib/crypto"
import { findOrCreateCustomer } from "@/lib/customers"
import { recordInteraction } from "@/lib/memory"
import { getPricing, priceUsage } from "@/lib/pricing"
import {
  claimProviderEvent,
  completeProviderEvent,
  failProviderEvent,
  type ProviderEventClaim,
} from "@/lib/provider-events"
import { createServiceClient } from "@/lib/supabase/service"
import type { InteractionRole, ShopRow } from "@/lib/types/database"
import { voiceBudgetState } from "@/lib/voice-provider"
import {
  cancelAppointment,
  captureLead,
  lookupCustomerHistory,
  lookupShopPolicy,
  proposeBooking,
  proposeQuote,
  quoteService,
  rescheduleAppointment,
  type VapiCallContext,
} from "@/lib/vapi-tools"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// ADR-001 C5: an explicit execution ceiling, strictly below the
// provider_events stale threshold passed to the end-of-call claim, so a
// live claimer can never be reclaimed as stale while still running.
// Both values are test-locked together in eval/webhooks.test.ts.
export const maxDuration = 60

/** provider_events stale-reclaim threshold for the end-of-call claim —
 *  must stay STRICTLY above maxDuration (ADR-001 C5). */
const STALE_AFTER_SECONDS = 300

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

type VapiToolCall = {
  id?: string
  name?: string
  function?: { name?: string; arguments?: Record<string, unknown> | string }
}

type VapiMessage = {
  type?: string
  call?: VapiCall
  functionCall?: {
    name?: string
    parameters?: Record<string, unknown>
  }
  toolCallList?: VapiToolCall[]
  messages?: VapiTurn[]
  transcript?: string
  endedReason?: string
  summary?: string
  recordingUrl?: string
  durationSeconds?: number
  durationMinutes?: number
  startedAt?: string
  endedAt?: string
  /** Vapi-reported call cost in USD — captured for the call record, never billing. */
  cost?: number
}

type VapiPayload = { message?: VapiMessage }

type WebhookShop = Pick<
  ShopRow,
  | "id"
  | "name"
  | "vapi_server_secret_enc"
  | "plan"
  | "tier"
  | "voice_addon"
  | "trial_ends_at"
  | "voice_minutes_budget"
>

function secretMatches(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Per-shop webhook auth (skill hard rule): the assistant carries a
 * per-shop server secret, echoed back as x-vapi-secret. Legacy assistants
 * created before per-shop secrets fall back to the env-global secret.
 * Fail closed when neither matches.
 */
function verifyVapiSecret(request: Request, shop: WebhookShop | null): boolean {
  const provided = request.headers.get("x-vapi-secret")
  const perShop = tryDecryptSecret(shop?.vapi_server_secret_enc)
  if (perShop) return secretMatches(provided, perShop)
  return secretMatches(provided, process.env.VAPI_WEBHOOK_SECRET?.trim() || null)
}

/** Production runtime detection for the VAPI_DEFAULT_SHOP_ID guard.
 *  VERCEL_ENV distinguishes production from preview (both build with
 *  NODE_ENV=production); self-hosted prod falls back to NODE_ENV. */
function isProductionRuntime(): boolean {
  const vercelEnv = process.env.VERCEL_ENV?.trim()
  if (vercelEnv) return vercelEnv === "production"
  return process.env.NODE_ENV === "production"
}

async function resolveShop(
  supabase: SupabaseClient,
  message: VapiMessage
): Promise<WebhookShop | null> {
  const select =
    "id, name, vapi_server_secret_enc, plan, tier, voice_addon, trial_ends_at, voice_minutes_budget"
  const assistantId = asString(message.call?.assistantId).trim()
  if (assistantId) {
    const { data, error } = await supabase
      .from("shops")
      .select(select)
      .eq("vapi_assistant_id", assistantId)
      .maybeSingle()
    if (error) {
      console.error("[vapi] shop lookup by assistant_id failed:", error)
    }
    if (data) return data as WebhookShop
  }

  const fallback = process.env.VAPI_DEFAULT_SHOP_ID?.trim()
  if (!fallback) return null
  // P0-007: the fallback is a single-shop DEV convenience only. In
  // production an unmatched assistant must fail closed — silently routing
  // another assistant's calls, transcripts, and metering into the default
  // shop is a cross-tenant misrouting hole (audit trace H).
  if (isProductionRuntime()) {
    console.error(
      "[vapi] VAPI_DEFAULT_SHOP_ID fallback refused in production — unmatched assistant fails closed",
      { assistantId: assistantId || null }
    )
    return null
  }
  const { data } = await supabase
    .from("shops")
    .select(select)
    .eq("id", fallback)
    .maybeSingle()
  return (data as WebhookShop | null) ?? null
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

/** Actual reported call duration in whole seconds, or null when Vapi sent
 *  nothing usable — the call record stores what was reported, not a guess.
 *  (Distinct from callMinutes(), which rounds UP for billing.) */
function reportedDurationSeconds(message: VapiMessage): number | null {
  if (typeof message.durationSeconds === "number" && message.durationSeconds > 0)
    return Math.round(message.durationSeconds)
  if (message.startedAt && message.endedAt) {
    const ms =
      new Date(message.endedAt).getTime() -
      new Date(message.startedAt).getTime()
    if (ms > 0) return Math.round(ms / 1000)
  }
  if (typeof message.durationMinutes === "number" && message.durationMinutes > 0)
    return Math.round(message.durationMinutes * 60)
  return null
}

/** Billed voice minutes for an ended call. Coarse + post-call by nature —
 *  Vapi is real-time, so we meter after the fact (we can't interrupt a live
 *  call). Rounds up; falls back to 1 minute when no duration is reported. */
function callMinutes(message: VapiMessage): number {
  if (typeof message.durationMinutes === "number" && message.durationMinutes > 0)
    return Math.max(1, Math.ceil(message.durationMinutes))
  if (typeof message.durationSeconds === "number" && message.durationSeconds > 0)
    return Math.max(1, Math.ceil(message.durationSeconds / 60))
  if (message.startedAt && message.endedAt) {
    const ms =
      new Date(message.endedAt).getTime() -
      new Date(message.startedAt).getTime()
    if (ms > 0) return Math.max(1, Math.ceil(ms / 60_000))
  }
  return 1
}

export async function POST(request: Request) {
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

  // Resolve before verify: the auth secret is per-shop (assistant-bound).
  // The payload is untrusted until verifyVapiSecret passes — resolution
  // only reads, and a wrong/forged assistantId fails verification anyway.
  const shop = await resolveShop(supabase, message)
  if (!shop) {
    console.error(
      "[vapi] no shop matched assistantId and no VAPI_DEFAULT_SHOP_ID fallback set",
      { assistantId: message.call?.assistantId ?? null }
    )
    return new Response("Shop not configured", { status: 404 })
  }
  if (!verifyVapiSecret(request, shop)) {
    return new Response("Invalid signature", { status: 401 })
  }
  const shopId = shop.id

  switch (message.type) {
    case "function-call":
      return handleFunctionCall(supabase, shopId, message)
    case "tool-calls":
      return handleToolCalls(supabase, shopId, message)
    case "end-of-call-report":
      return handleEndOfCall(supabase, shop, message)
    default:
      // status-update, transcript chunks, hang, etc — ack and ignore for MVP
      return Response.json({ ok: true })
  }
}

/**
 * Dispatches one named tool invocation to its handler — shared by the
 * legacy `function-call` shape and the `tool-calls` shape that
 * model.tools-declared assistants send.
 */
async function dispatchTool(
  supabase: SupabaseClient,
  shopId: string,
  name: string,
  params: Record<string, unknown>,
  ctx: VapiCallContext
): Promise<string> {
  switch (name) {
    case "capture_lead":
      return captureLead(supabase, shopId, params, ctx)
    case "propose_booking":
      return proposeBooking(supabase, shopId, params, ctx)
    case "quote_service":
      return quoteService(supabase, shopId, params, ctx)
    case "propose_quote":
      return proposeQuote(supabase, shopId, params, ctx)
    case "lookup_customer_history":
      return lookupCustomerHistory(supabase, shopId, params, ctx)
    case "lookup_shop_policy":
      return lookupShopPolicy(supabase, shopId, params, ctx)
    case "reschedule_appointment":
      return rescheduleAppointment(supabase, shopId, params, ctx)
    case "cancel_appointment":
      return cancelAppointment(supabase, shopId, params, ctx)
    default:
      return `Unknown function: ${name}`
  }
}

/** `tool-calls` event (assistants with model.tools). Response contract:
 *  { results: [{ toolCallId, result }] }. */
async function handleToolCalls(
  supabase: SupabaseClient,
  shopId: string,
  message: VapiMessage
): Promise<Response> {
  const ctx = callContextFrom(message)
  const calls = message.toolCallList ?? []
  const results: { toolCallId: string; result: string }[] = []
  for (const call of calls) {
    const name = call.function?.name ?? call.name ?? ""
    let args: Record<string, unknown> = {}
    const rawArgs = call.function?.arguments
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>
      } catch {
        args = {}
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs
    }
    results.push({
      toolCallId: call.id ?? "",
      result: name
        ? await dispatchTool(supabase, shopId, name, args, ctx)
        : "No function specified.",
    })
  }
  return Response.json({ results })
}

/** Legacy `function-call` event shape — same dispatcher underneath. */
async function handleFunctionCall(
  supabase: SupabaseClient,
  shopId: string,
  message: VapiMessage
): Promise<Response> {
  const fn = message.functionCall
  if (!fn?.name) {
    return Response.json({ result: "No function specified." })
  }
  const result = await dispatchTool(
    supabase,
    shopId,
    fn.name,
    fn.parameters ?? {},
    callContextFrom(message)
  )
  return Response.json({ result })
}

/**
 * End-of-call report — the one Vapi event type this route claims through
 * provider_events (P0-007, ADR-001 C3/C5). Ordering is load-bearing:
 * signature verification happened in POST; here we validate the call id
 * (the durable provider event id — never claim or meter without one),
 * claim, process, then complete/fail. Replays of the same call id are
 * suppressed with the same 2xx Vapi expects; processing failures 5xx so
 * Vapi's retry reclaims and reprocesses.
 *
 * Event-identity assumption (documented per the ticket): the bare
 * `call.id` is the event id because the end-of-call report is the ONLY
 * Vapi event type that claims. If a future ticket claims another Vapi
 * event type it must namespace (`${callId}:${type}`) or amend ADR-001.
 */
async function handleEndOfCall(
  supabase: SupabaseClient,
  shop: WebhookShop,
  message: VapiMessage
): Promise<Response> {
  const shopId = shop.id
  const vapiCallId = asString(message.call?.id).trim()
  if (!vapiCallId) {
    // D-023: never process a provider event with no provider identifier —
    // there is nothing durable to claim, dedupe, or meter against.
    console.error(
      "[vapi] end-of-call report missing call id — refusing to process",
      { shopId }
    )
    return new Response("Missing call id", { status: 400 })
  }

  // Claim strictly AFTER signature verification (ADR-001 C3) and strictly
  // BEFORE any write. A claim-storage outage fails closed: 5xx, never
  // process unguarded — Vapi retries later.
  let claim: ProviderEventClaim
  try {
    claim = await claimProviderEvent(supabase, {
      provider: "vapi",
      eventId: vapiCallId,
      shopId,
      staleAfterSeconds: STALE_AFTER_SECONDS,
    })
  } catch (err) {
    console.error("[vapi] provider-event claim failed:", err)
    return new Response("Server error", { status: 500 })
  }

  if (!claim.shouldProcess) {
    // Duplicate suppression is a normal outcome (the helper already emits
    // the [idempotency] info line P0-012 counts); this line adds the shop
    // + which writes were skipped, per the ticket's observability spec.
    console.info(
      "[vapi] duplicate end-of-call delivery suppressed — transcript, metering, budget, and call-record writes skipped",
      { vapiCallId, shopId, outcome: claim.outcome }
    )
    return Response.json({ ok: true, duplicate: true })
  }

  let turnsIngested = 0
  try {
    turnsIngested = await processEndOfCall(
      supabase,
      shop,
      message,
      vapiCallId,
      claim
    )
  } catch (err) {
    console.error("[vapi] end-of-call processing failed:", err)
    try {
      await failProviderEvent(supabase, "vapi", vapiCallId, err)
    } catch (markErr) {
      // Claim stays 'processing' — reclaimable as stale after the
      // threshold, so the event is never permanently stranded.
      console.error("[vapi] fail-mark failed:", markErr)
    }
    // 5xx keeps Vapi's retry path open: the failed claim is explicitly
    // reclaimable (reclaimed_failed), so a legitimate retry reprocesses.
    return new Response("Processing failed", { status: 500 })
  }

  try {
    await completeProviderEvent(supabase, "vapi", vapiCallId)
  } catch (err) {
    // Side effects already landed; return success so Vapi doesn't retry
    // into an error loop. The claim stays 'processing' and is only
    // reachable again via a stale reclaim on an unusually late retry —
    // safe here because every end-of-call write is individually
    // idempotent (turn resume, metering unique, call-record upsert).
    console.error("[vapi] complete-mark failed:", err)
  }

  return Response.json({ ok: true, turnsIngested })
}

/**
 * The processing body of an owned end-of-call claim. Persists every turn
 * of the call into the shared memory layer, meters the minutes, applies
 * the budget policy, and captures the call record. Throws on any loss of
 * required durable state so the claim is failed and Vapi's retry can
 * converge — every write is resume-safe under the serialized claim.
 */
async function processEndOfCall(
  supabase: SupabaseClient,
  shop: WebhookShop,
  message: VapiMessage,
  vapiCallId: string,
  claim: ProviderEventClaim
): Promise<number> {
  const shopId = shop.id
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

  const turns = (message.messages ?? [])
    .map((turn) => ({
      turn,
      content: (asString(turn.message) || asString(turn.content)).trim(),
    }))
    .filter((t) => t.content)

  // Retry-after-failure resume (ADR-001): a failed first attempt may have
  // persisted a prefix of the transcript. The claim serializes execution
  // per call id, so a count-based resume is race-free — skip exactly the
  // turns already written (the retried payload is the same report, so
  // turn order is deterministic) and write the rest. Fresh claims skip
  // the lookup entirely.
  let alreadyWritten = 0
  if (claim.outcome !== "claimed") {
    const { count, error } = await supabase
      .from("interactions")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .eq("channel", "voice")
      .eq("metadata->>vapi_call_id", vapiCallId)
    if (error) {
      throw new Error(
        `[vapi] reprocess transcript lookup failed: ${error.message}`
      )
    }
    alreadyWritten = count ?? 0
    if (alreadyWritten > 0) {
      console.info(
        "[idempotency] vapi transcript resume — skipping already-written turns",
        { shopId, vapiCallId, alreadyWritten }
      )
    }
  }

  for (let i = alreadyWritten; i < turns.length; i++) {
    const { turn, content } = turns[i]
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
        vapi_call_id: vapiCallId,
        ended_reason: message.endedReason ?? null,
        recording_url: message.recordingUrl ?? null,
      },
    })

    if (!result.ok) {
      // Losing a transcript turn silently would complete the event with a
      // partial transcript. Fail the claim so Vapi's retry resumes here.
      throw new Error(
        `[vapi] transcript interaction insert failed: ${result.error}`
      )
    }
  }

  // Meter the call at the BUNDLED retail rate (Twilio + Vapi + model in
  // one per-minute price). Post-call by nature — voice is real-time.
  // credits: 0 — minutes are their OWN meter (GRADIA_PRICING.md: the two
  // meters never cross; voice can't drain message credits). wholesale +
  // retail stay on the row so margin is computable.
  //
  // vendor_ref = call id: the P0-005 (shop_id, kind, vendor_ref) unique is
  // the defense-in-depth behind the claim — a replayed write is a clean
  // duplicate, a lost write must NOT silently bill nothing (P0-006's
  // metering lesson): failed → throw → the provider retry re-meters.
  const minutes = callMinutes(message)
  const pricing = await getPricing(supabase)
  const priced = priceUsage(pricing, "voice_minute", minutes)
  const metered = await recordUsage(supabase, shopId, "voice_minute", {
    quantity: minutes,
    credits: 0,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
    vendorRef: vapiCallId,
    refId: vapiCallId,
  })
  if (metered === "duplicate") {
    console.info(
      "[idempotency] vapi voice-minute metering already recorded — skipped",
      { shopId, vapiCallId }
    )
  } else if (metered === "failed") {
    throw new Error(
      "[vapi] voice-minute metering write failed — failing event so the provider retry re-meters"
    )
  }

  // Minute budget (spec §2.5): warn at 80%; at 100% mark the assistant
  // stale so the hourly voice sync PATCHes in the take-a-message fallback
  // — that's how the NEXT call gets refused (can't cut a live one).
  const budget = await voiceBudgetState(supabase, shop)
  if (budget.over) {
    console.warn(
      `[vapi] shop ${shopId} is over its voice budget (${budget.usedMinutes}/${budget.budget} min) — queuing fallback sync`
    )
    await supabase.from("shops").update({ vapi_stale: true }).eq("id", shopId)
  } else if (budget.warn) {
    console.warn(
      `[vapi] shop ${shopId} at ${budget.usedMinutes}/${budget.budget} voice minutes (≥80%)`
    )
  }

  // Glass Box capture (redesign spec §8-A6a): persist the per-call artifact
  // (summary, duration, vendor cost, ended reason, recording) that used to
  // be dropped here after metering. Ordered AFTER metering + budget so the
  // billing path is untouched; persistCallRecord never throws by contract,
  // so a capture failure can't fail this webhook.
  await persistCallRecord(supabase, {
    shopId,
    customerId,
    vapiCallId,
    summary: message.summary ?? null,
    endedReason: message.endedReason ?? null,
    recordingUrl: message.recordingUrl ?? null,
    durationSeconds: reportedDurationSeconds(message),
    vendorCost: typeof message.cost === "number" ? message.cost : null,
    startedAt: message.startedAt ?? null,
    endedAt: message.endedAt ?? null,
  })

  revalidatePath("/dashboard")
  revalidatePath("/leads")
  revalidatePath("/approvals")

  return turns.length
}
