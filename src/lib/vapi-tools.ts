/**
 * Vapi function-tool handlers. Each takes (supabase, shopId, params, ctx)
 * and returns a string the assistant will speak back to the caller —
 * already in we/us tone per HUMAN.md. Strings are kept short for low
 * TTS latency and natural delivery.
 *
 * Tools:
 *   - capture_lead          — log a general inquiry (HITL via Slack)
 *   - propose_booking       — log a quoted booking request (HITL via Slack)
 *   - quote_service         — read the shop's service menu
 *   - lookup_customer_history — recall recent touchpoints across channels
 *   - lookup_shop_policy    — RAG over the shop knowledge base (FAQs,
 *                              deposits, weather, hours)
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"

import { findCustomerByChannel } from "@/lib/customers"
import { getCrossChannelHint } from "@/lib/customer-context"
import { recordActionDecision } from "@/lib/decision-log"
import { searchShopKnowledge } from "@/lib/knowledge"
import { recentChannelActivity, recentInteractions } from "@/lib/memory"
import { describePrice, resolveDurationMinutes } from "@/lib/service-pricing"
import {
  sendBookingApprovalRequest,
  sendLeadApprovalRequest,
} from "@/lib/slack"
import type {
  InteractionChannel,
  LeadStatus,
  ServiceRow,
} from "@/lib/types/database"

export type VapiCallContext = {
  id?: string
  callerPhone?: string
  callerName?: string
}

// ---------- formatters tuned for TTS ----------
// Prices come from lib/service-pricing (describePrice) — the shared
// resolution module — so voice quotes and CRM quotes can never disagree.

function speakDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = minutes / 60
  if (hours === 1) return "about an hour"
  if (Number.isInteger(hours)) return `about ${hours} hours`
  return `about ${hours.toFixed(1).replace(".0", "")} hours`
}

function speakRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`
  const weeks = Math.round(days / 7)
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`
}

function asString(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return String(value)
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] || full
}

// Tolerant param reads — Vapi tool schemas land as snake_case but LLMs
// occasionally emit camelCase too. Accept both.
function readParam(
  params: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const k of keys) {
    const v = params[k]
    if (v !== undefined && v !== null) {
      const s = asString(v).trim()
      if (s) return s
    }
  }
  return ""
}

// ---------- shared lead-proposal flow (used by capture_lead + propose_booking) ----------

async function submitLeadProposal(
  supabase: SupabaseClient,
  shopId: string,
  proposal: {
    customerName: string
    phone: string
    carInfo: string | null
    pinNotes: string | null
    status: LeadStatus
    extras: Record<string, unknown>
  },
  ctx: VapiCallContext
): Promise<{ ok: true; pendingId: string } | { ok: false; reason: string }> {
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("owner_id")
    .eq("id", shopId)
    .single()

  if (shopErr || !shop?.owner_id) {
    console.error("[vapi-tools] shop owner not found for", shopId, shopErr)
    return { ok: false, reason: "shop_not_found" }
  }

  const payload = {
    customer_name: proposal.customerName,
    phone: proposal.phone,
    car_info: proposal.carInfo,
    pin_notes: proposal.pinNotes,
    status: proposal.status,
    source: "voice",
    vapi_call_id: ctx.id ?? null,
    ...proposal.extras,
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shopId,
      action_type: "create_lead",
      payload,
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error("[vapi-tools] pending_action insert failed:", pendingErr)
    return { ok: false, reason: "pending_action_failed" }
  }

  // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
  await recordActionDecision(supabase, {
    shopId,
    pendingActionId: pending.id,
    source: "voice",
    because: `Staged this lead because ${proposal.customerName || "a caller"} shared their details on a call to your receptionist.`,
    inputs: {
      rule: "voice_capture_lead",
      vapi_call_id: ctx.id ?? null,
      lead_status: proposal.status,
    },
  })

  // Resolve customer (best-effort) so we can surface cross-channel
  // context on the Slack card.
  const customer = await findCustomerByChannel(supabase, shopId, {
    phone: proposal.phone,
  })
  const crossChannelHint = await getCrossChannelHint(
    supabase,
    shopId,
    customer?.id ?? null,
    "voice"
  )

  try {
    await sendLeadApprovalRequest({
      pendingActionId: pending.id,
      customerName: proposal.customerName,
      phone: proposal.phone,
      carInfo: proposal.carInfo,
      pinNotes: proposal.pinNotes,
      status: proposal.status,
      crossChannelHint,
    })
  } catch (slackErr) {
    console.error("[vapi-tools] Slack approval send failed:", slackErr)
  }

  revalidatePath("/approvals")

  return { ok: true, pendingId: pending.id }
}

// ---------- capture_lead ----------

export async function captureLead(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  ctx: VapiCallContext
): Promise<string> {
  const customerName = readParam(params, "customer_name", "customerName")
  const phone =
    readParam(params, "phone") || asString(ctx.callerPhone).trim()
  const vehicle =
    readParam(params, "vehicle", "car_info", "carInfo") || null
  const service = readParam(params, "service") || null
  const notes = readParam(params, "notes", "note") || null

  if (!customerName || !phone) {
    return "I couldn't catch the name and phone — could we try those one more time?"
  }

  const pinNotes =
    [service && `Requested: ${service}`, notes]
      .filter((s): s is string => Boolean(s))
      .join(" — ") || null

  const result = await submitLeadProposal(
    supabase,
    shopId,
    {
      customerName,
      phone,
      carInfo: vehicle,
      pinNotes,
      status: "new",
      extras: {},
    },
    ctx
  )

  if (!result.ok) {
    return "Something went wrong on our end — let me have someone follow up."
  }

  return `Got it, ${firstName(customerName)} — we'll confirm shortly and text you the details.`
}

// ---------- propose_booking ----------

function parseIsoOrNull(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

async function lookupServiceDuration(
  supabase: SupabaseClient,
  shopId: string,
  serviceName: string
): Promise<number | null> {
  if (!serviceName) return null
  const { data } = await supabase
    .from("services")
    .select("name, duration_minutes")
    .eq("shop_id", shopId)
  const services = (data as ServiceRow[] | null) ?? []
  const q = serviceName.toLowerCase()
  const match =
    services.find((s) => s.name.toLowerCase() === q) ??
    services.find((s) => s.name.toLowerCase().includes(q))
  return match?.duration_minutes ?? null
}

async function submitBookingProposal(
  supabase: SupabaseClient,
  shopId: string,
  proposal: {
    customerName: string
    phone: string
    carInfo: string | null
    service: string
    isoStartTime: string
    durationMinutes: number
    timezone: string | null
    pinNotes: string | null
  },
  ctx: VapiCallContext
): Promise<{ ok: true; pendingId: string } | { ok: false; reason: string }> {
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("owner_id")
    .eq("id", shopId)
    .single()

  if (shopErr || !shop?.owner_id) {
    console.error("[vapi-tools] shop owner not found for", shopId, shopErr)
    return { ok: false, reason: "shop_not_found" }
  }

  const payload = {
    customer_name: proposal.customerName,
    phone: proposal.phone,
    car_info: proposal.carInfo,
    service: proposal.service,
    iso_start_time: proposal.isoStartTime,
    duration_minutes: proposal.durationMinutes,
    timezone: proposal.timezone,
    email: null,
    pin_notes: proposal.pinNotes,
    source: "voice",
    vapi_call_id: ctx.id ?? null,
  }

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shopId,
      action_type: "book_appointment",
      payload,
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error(
      "[vapi-tools] book_appointment pending_action insert failed:",
      pendingErr
    )
    return { ok: false, reason: "pending_action_failed" }
  }

  // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
  await recordActionDecision(supabase, {
    shopId,
    pendingActionId: pending.id,
    source: "voice",
    because: `Staged this booking because the caller agreed to ${proposal.service} on the call — bookings always wait for your approval.`,
    inputs: {
      rule: "voice_propose_booking",
      vapi_call_id: ctx.id ?? null,
      iso_start_time: proposal.isoStartTime,
    },
  })

  const customer = await findCustomerByChannel(supabase, shopId, {
    phone: proposal.phone,
  })
  const crossChannelHint = await getCrossChannelHint(
    supabase,
    shopId,
    customer?.id ?? null,
    "voice"
  )

  try {
    await sendBookingApprovalRequest({
      pendingActionId: pending.id,
      customerName: proposal.customerName,
      phone: proposal.phone,
      service: proposal.service,
      carInfo: proposal.carInfo,
      startIso: proposal.isoStartTime,
      durationMinutes: proposal.durationMinutes,
      timezone: proposal.timezone,
      crossChannelHint,
    })
  } catch (slackErr) {
    console.error("[vapi-tools] booking Slack approval send failed:", slackErr)
  }

  revalidatePath("/approvals")
  return { ok: true, pendingId: pending.id }
}

export async function proposeBooking(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  ctx: VapiCallContext
): Promise<string> {
  const customerName = readParam(params, "customer_name", "customerName")
  const phone =
    readParam(params, "phone") || asString(ctx.callerPhone).trim()
  const service = readParam(params, "service")
  const when =
    readParam(params, "when", "requested_when", "requestedWhen", "time")
  const isoStart = parseIsoOrNull(
    readParam(params, "iso_start_time", "isoStartTime", "startIso")
  )
  const durationRaw = readParam(
    params,
    "duration_minutes",
    "durationMinutes"
  )
  const durationParam = Number.parseInt(durationRaw, 10)
  const timezone =
    readParam(params, "timezone", "timeZone", "tz") || null
  const vehicle =
    readParam(params, "vehicle", "car_info", "carInfo") || null
  const notes = readParam(params, "notes", "note") || null

  if (!customerName || !phone || !service || !when) {
    const missing = [
      !customerName && "name",
      !phone && "phone",
      !service && "what they want done",
      !when && "when they want it",
    ]
      .filter(Boolean)
      .join(", ")
    return `Almost there — I still need ${missing}. Could we go through that one more time?`
  }

  // If the model gave us a parseable ISO time, propose a real booking
  // — calendar event on approve. Otherwise fall back to a quoted lead
  // so a human can clarify the time.
  if (isoStart) {
    const fallbackDuration =
      Number.isFinite(durationParam) && durationParam > 0
        ? durationParam
        : (await lookupServiceDuration(supabase, shopId, service)) ?? 90

    const pinNotes =
      [
        `Booking ask: ${service} on ${when}`,
        notes,
      ]
        .filter((s): s is string => Boolean(s))
        .join(" — ") || null

    const result = await submitBookingProposal(
      supabase,
      shopId,
      {
        customerName,
        phone,
        carInfo: vehicle,
        service,
        isoStartTime: isoStart,
        durationMinutes: fallbackDuration,
        timezone,
        pinNotes,
      },
      ctx
    )

    if (!result.ok) {
      return "Something went wrong saving that — let me have someone confirm with you."
    }

    return `Perfect — we'll text ${firstName(customerName)} to lock in ${service} for ${when}.`
  }

  const pinNotes =
    [
      `Booking request: ${service} on ${when}`,
      notes,
    ]
      .filter((s): s is string => Boolean(s))
      .join(" — ")

  const result = await submitLeadProposal(
    supabase,
    shopId,
    {
      customerName,
      phone,
      carInfo: vehicle,
      pinNotes,
      status: "quoted",
      extras: {
        requested_service: service,
        requested_when: when,
      },
    },
    ctx
  )

  if (!result.ok) {
    return "Something went wrong saving that — let me have someone confirm with you."
  }

  return `Perfect — we'll text ${firstName(customerName)} to lock in ${service} for ${when}.`
}

// ---------- quote_service ----------

function matchServices(services: ServiceRow[], query: string): ServiceRow[] {
  const q = query.toLowerCase().trim()
  if (!q) return []

  // Exact + contains match on name; fall back to description contains.
  const byName = services.filter((s) => s.name.toLowerCase().includes(q))
  if (byName.length > 0) return byName

  return services.filter((s) =>
    (s.description ?? "").toLowerCase().includes(q)
  )
}

export async function quoteService(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  _ctx: VapiCallContext
): Promise<string> {
  void _ctx
  const query = readParam(params, "service", "name", "query")

  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("shop_id", shopId)
    .order("price_cents", { ascending: true })

  if (error) {
    console.error("[vapi-tools] service list failed:", error)
    return "I'm having trouble pulling up our menu — let me have someone call you back with pricing."
  }

  const services = (data as ServiceRow[] | null) ?? []
  if (services.length === 0) {
    return "We're still finalizing our menu — can I take down your details and have someone reach out with pricing?"
  }

  const matches = query ? matchServices(services, query) : []

  if (matches.length === 1) {
    const s = matches[0]
    const desc = s.description ? ` ${s.description}.` : ""
    return `${s.name} is ${describePrice(s)} and runs ${speakDuration(resolveDurationMinutes(s))}.${desc} Want us to get that booked?`
  }

  if (matches.length > 1) {
    const top = matches.slice(0, 3)
    const list = top
      .map(
        (s) =>
          `${s.name} at ${describePrice(s)} (${speakDuration(resolveDurationMinutes(s))})`
      )
      .join(", ")
    return `We have a few options — ${list}. Which sounds right?`
  }

  // No specific match: read the menu (cap at 5).
  const top = services.slice(0, 5)
  const list = top.map((s) => `${s.name} at ${describePrice(s)}`).join(", ")
  return `We don't have that exact thing on our menu, but here's what we offer: ${list}. Want one of those?`
}

// ---------- lookup_customer_history ----------

const CHANNEL_PHRASE: Record<InteractionChannel, string> = {
  voice: "called us",
  sms: "texted us",
  email: "emailed us",
  web: "reached out from our site",
  note: "left a note for us",
}

export async function lookupCustomerHistory(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  ctx: VapiCallContext
): Promise<string> {
  const phone =
    readParam(params, "phone") || asString(ctx.callerPhone).trim()

  if (!phone) {
    return "I don't have a phone on file yet — could I get yours so we can pull our history?"
  }

  const customer = await findCustomerByChannel(supabase, shopId, { phone })
  if (!customer) {
    return "Looks like this is our first time talking — happy to get you set up."
  }

  const recent = await recentInteractions(supabase, shopId, customer.id, 5)
  const otherChannels = await recentChannelActivity(
    supabase,
    shopId,
    customer.id,
    {
      excludeChannel: "voice",
      withinMinutes: 60 * 24 * 7, // last 7 days
    }
  )

  const parts: string[] = []
  parts.push(`Customer on file: ${customer.name ?? "name unknown"}`)

  if (recent.length > 0) {
    const last = recent[0]
    const preview = last.content.slice(0, 80)
    parts.push(
      `Last touchpoint ${speakRelative(last.occurred_at)} on ${last.channel}: "${preview}${last.content.length > 80 ? "…" : ""}".`
    )
  } else {
    parts.push("No prior conversations logged yet.")
  }

  if (otherChannels.length > 0) {
    const flag = otherChannels
      .slice(0, 2)
      .map(
        (a) =>
          `${CHANNEL_PHRASE[a.channel]} ${speakRelative(a.occurred_at)}`
      )
      .join("; ")
    parts.push(`Heads up — also ${flag}.`)
  }

  return parts.join(" ")
}

// ---------- lookup_shop_policy ----------

/**
 * RAG over the shop knowledge base. Caller asks "what's your
 * deposit policy?" / "are you open Sundays?" / "do you do PPF?" and
 * we pull the most-relevant entries the owner pasted in /settings.
 * Returns a short TTS-friendly answer that quotes the policy
 * verbatim where it makes sense — voice agents shouldn't paraphrase
 * the owner's actual words.
 */
export async function lookupShopPolicy(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  _ctx: VapiCallContext
): Promise<string> {
  void _ctx
  const query = readParam(params, "question", "query", "topic")
  if (!query) {
    return "Sure — what specifically did you want to check on?"
  }

  const matches = await searchShopKnowledge(supabase, shopId, query, {
    limit: 2,
  })

  if (matches.length === 0) {
    return "I don't have that one written down yet — let me grab the owner so we get you the right answer."
  }

  // Speak the top match in the owner's own words. If we have two
  // matches close in similarity, mention both compactly.
  const top = matches[0]
  const second = matches[1]
  if (
    second &&
    second.similarity > 0.55 &&
    second.similarity >= top.similarity - 0.08
  ) {
    return `On ${top.source_name.toLowerCase()}: ${top.content} And on ${second.source_name.toLowerCase()}: ${second.content}`
  }
  return `On ${top.source_name.toLowerCase()}: ${top.content}`
}

// ---------- reschedule_appointment / cancel_appointment ----------
//
// Both are CALENDAR WRITES → ALWAYS_HITL (locked principle #4). The voice
// agent never moves or deletes anything: it finds the caller's upcoming
// appointment, stages an approval with the ask, and tells the caller the
// team will text to confirm. Same staging pattern as propose_booking.

type UpcomingAppointment = {
  id: string
  scheduled_at: string
  service_name: string | null
}

/** The caller's next upcoming appointment, matched by phone. */
async function findUpcomingAppointmentByPhone(
  supabase: SupabaseClient,
  shopId: string,
  phone: string
): Promise<UpcomingAppointment | null> {
  const { data: customer } = await supabase
    .from("customers")
    .select("id")
    .eq("shop_id", shopId)
    .eq("phone", phone)
    .maybeSingle()
  if (!customer?.id) return null

  const { data } = await supabase
    .from("appointments")
    .select("id, scheduled_at, service_name")
    .eq("shop_id", shopId)
    .eq("customer_id", customer.id)
    .gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as UpcomingAppointment | null) ?? null
}

async function stageAppointmentChange(
  supabase: SupabaseClient,
  shopId: string,
  actionType: "reschedule_appointment" | "cancel_appointment",
  payload: Record<string, unknown>
): Promise<boolean> {
  const { data: shop, error: shopErr } = await supabase
    .from("shops")
    .select("owner_id")
    .eq("id", shopId)
    .single()
  if (shopErr || !shop?.owner_id) {
    console.error("[vapi-tools] shop owner not found for", shopId, shopErr)
    return false
  }
  const { data: pending, error } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shopId,
      action_type: actionType,
      payload,
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()
  if (error || !pending) {
    console.error(`[vapi-tools] ${actionType} stage failed:`, error)
    return false
  }

  // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
  const newWhen =
    typeof payload.new_when === "string" && payload.new_when.trim()
      ? ` to "${payload.new_when.trim()}"`
      : ""
  const because =
    actionType === "reschedule_appointment"
      ? `Staged because the caller asked to move their appointment${newWhen} — calendar changes always wait for your approval.`
      : "Staged because the caller asked to cancel their appointment — calendar changes always wait for your approval."
  await recordActionDecision(supabase, {
    shopId,
    pendingActionId: pending.id,
    source: "voice",
    because,
    inputs: {
      rule: `voice_${actionType}`,
      vapi_call_id: payload.vapi_call_id ?? null,
      appointment_id: payload.appointment_id ?? null,
    },
  })
  return true
}

export async function rescheduleAppointment(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  ctx: VapiCallContext
): Promise<string> {
  const customerName = readParam(params, "customer_name", "customerName")
  const phone = readParam(params, "phone") || asString(ctx.callerPhone).trim()
  const newWhen = readParam(params, "new_when", "newWhen", "when")
  const isoNewStart = readParam(params, "iso_new_start_time", "isoNewStartTime")

  if (!phone || !newWhen) {
    const missing = [!phone && "a phone number", !newWhen && "the new time"]
      .filter(Boolean)
      .join(" and ")
    return `Happy to move it — I just need ${missing}.`
  }

  const appointment = await findUpcomingAppointmentByPhone(supabase, shopId, phone)
  const staged = await stageAppointmentChange(supabase, shopId, "reschedule_appointment", {
    appointment_id: appointment?.id ?? null,
    current_scheduled_at: appointment?.scheduled_at ?? null,
    service: appointment?.service_name ?? null,
    customer_name: customerName || null,
    phone,
    new_when: newWhen,
    iso_new_start_time: isoNewStart || null,
    source: "voice",
    vapi_call_id: ctx.id ?? null,
  })
  if (!staged) {
    return "Something went wrong saving that — let me have someone confirm the new time with you."
  }
  return appointment
    ? `Got it — we'll move the ${appointment.service_name ?? "appointment"} and text ${customerName ? firstName(customerName) : "you"} to confirm ${newWhen}.`
    : `Got it — I couldn't see the booking from here, but the team will find it and text to confirm ${newWhen}.`
}

export async function cancelAppointment(
  supabase: SupabaseClient,
  shopId: string,
  params: Record<string, unknown>,
  ctx: VapiCallContext
): Promise<string> {
  const customerName = readParam(params, "customer_name", "customerName")
  const phone = readParam(params, "phone") || asString(ctx.callerPhone).trim()
  const reason = readParam(params, "reason", "notes") || null

  if (!phone) {
    return "Of course — what's the best number on the booking so we cancel the right one?"
  }

  const appointment = await findUpcomingAppointmentByPhone(supabase, shopId, phone)
  const staged = await stageAppointmentChange(supabase, shopId, "cancel_appointment", {
    appointment_id: appointment?.id ?? null,
    current_scheduled_at: appointment?.scheduled_at ?? null,
    service: appointment?.service_name ?? null,
    customer_name: customerName || null,
    phone,
    reason,
    source: "voice",
    vapi_call_id: ctx.id ?? null,
  })
  if (!staged) {
    return "Something went wrong on my end — the team will call you right back to sort the cancellation."
  }
  return "Done — we'll take it off the books and text you a confirmation. Hope we see you again soon."
}
