/**
 * Custom-agent runtime. Dispatches enabled agents matching their
 * cadence to recipe-specific executors. Recipes are coded handlers
 * with known semantics; the planner is constrained to pick from this
 * catalog when it emits a `recipe` block on the config.
 *
 * Only `lead_followup_sms` ships in this chunk. Future recipes plug
 * in alongside via `RECIPE_HANDLERS`.
 *
 * Every outbound recipe respects HITL — actions stage `send_sms` /
 * `send_email` pending_actions, never send directly.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { findCustomerByChannel } from "@/lib/customers"
import { draftAppointmentReminderEmail } from "@/lib/email-drafter"
import {
  sendEmailApprovalRequest,
  sendSmsApprovalRequest,
} from "@/lib/slack"
import { draftCustomSmsForCustomer } from "@/lib/sms-drafter"
import type {
  AgentConfig,
  AppointmentRow,
  CustomAgentRow,
  CustomerRow,
  LeadRow,
  ShopRow,
} from "@/lib/types/database"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MIN_GAP_MS: Record<"hourly" | "daily" | "weekly", number> = {
  hourly: 50 * 60 * 1000, // 50 min
  daily: 23 * HOUR_MS,
  weekly: 6 * DAY_MS,
}

export type AgentRunOutcome = {
  agentId: string
  agentName: string
  fired: boolean
  /** Why we didn't fire, when fired === false. */
  reason?: string
  /** Per-recipe counters (e.g., { proposed_sms: 3, skipped_already_contacted: 1 }). */
  stats?: Record<string, number>
}

function isCadenceWindowOpen(
  schedule: AgentConfig["schedule"],
  now: Date
): { open: boolean; reason?: string } {
  if (!schedule) return { open: false, reason: "no schedule" }
  if (schedule.cadence === "hourly") return { open: true }
  const hour = now.getUTCHours()
  const expectedHour = schedule.hour_of_day ?? 14
  if (hour !== expectedHour) {
    return {
      open: false,
      reason: `hour ${hour} ≠ ${expectedHour} (UTC) — waits for window`,
    }
  }
  if (schedule.cadence === "weekly") {
    const expectedDow = schedule.day_of_week ?? 1
    if (now.getUTCDay() !== expectedDow) {
      return {
        open: false,
        reason: `weekday ${now.getUTCDay()} ≠ ${expectedDow} — wrong day`,
      }
    }
  }
  return { open: true }
}

function shouldFireOnSchedule(
  agent: CustomAgentRow,
  now: Date
): { fire: boolean; reason?: string } {
  const schedule = agent.config.schedule
  if (!schedule) return { fire: false, reason: "no schedule on config" }

  const window = isCadenceWindowOpen(schedule, now)
  if (!window.open) return { fire: false, reason: window.reason }

  if (agent.last_fired_at) {
    const elapsed = now.getTime() - new Date(agent.last_fired_at).getTime()
    if (elapsed < MIN_GAP_MS[schedule.cadence]) {
      return {
        fire: false,
        reason: `fired recently (${Math.round(elapsed / 60_000)}m ago)`,
      }
    }
  }
  return { fire: true }
}

async function stampFired(
  supabase: SupabaseClient,
  agentId: string,
  shopId: string
): Promise<void> {
  await supabase
    .from("custom_agents")
    .update({ last_fired_at: new Date().toISOString() })
    .eq("id", agentId)
    .eq("shop_id", shopId)
}

// ---------- recipe: lead_followup_sms ----------

async function executeLeadFollowupSms(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow
): Promise<AgentRunOutcome> {
  const stats = { matched: 0, proposed_sms: 0, skipped_no_phone: 0, skipped_recent_inbound: 0 }
  const recipe = agent.config.recipe
  if (!recipe || recipe.id !== "lead_followup_sms") {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "recipe missing or wrong id",
    }
  }
  if (!shop.twilio_phone_number) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "Twilio number not connected",
    }
  }

  const { status, min_lead_age_days, no_inbound_within_days } = recipe.params

  const now = Date.now()
  const ageCutoffIso = new Date(now - min_lead_age_days * DAY_MS).toISOString()
  const recentInboundCutoffIso = new Date(
    now - no_inbound_within_days * DAY_MS
  ).toISOString()

  const { data: leadRows, error: leadErr } = await supabase
    .from("leads")
    .select("*")
    .eq("shop_id", shop.id)
    .eq("status", status)
    .lte("created_at", ageCutoffIso)
    .order("created_at", { ascending: true })
    .limit(50)

  if (leadErr) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: `lead query failed: ${leadErr.message}`,
    }
  }
  const leads = (leadRows as LeadRow[] | null) ?? []
  stats.matched = leads.length

  for (const lead of leads) {
    if (!lead.phone?.trim()) {
      stats.skipped_no_phone += 1
      continue
    }

    // Skip when the customer reached out recently — we don't want to
    // pester someone mid-conversation.
    const { data: recentInbound } = await supabase
      .from("interactions")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("role", "customer")
      .gte("occurred_at", recentInboundCutoffIso)
      .or(
        lead.customer_id
          ? `customer_id.eq.${lead.customer_id}`
          : `metadata->>from_phone.eq.${lead.phone}`
      )
      .limit(1)

    if (recentInbound && recentInbound.length > 0) {
      stats.skipped_recent_inbound += 1
      continue
    }

    const draft = await draftCustomSmsForCustomer({
      shopName: shop.name,
      customerName: lead.customer_name,
      vehicle: lead.car_info,
      service: lead.pin_notes,
      intent: agent.config.action.intent_summary,
    }).catch(() => null)

    if (!draft) continue

    const reason = `Custom agent · ${agent.name}`

    // Look up the customer FK if we have it from the lead.
    const customer = lead.customer_id
      ? await findCustomerByChannel(supabase, shop.id, { phone: lead.phone })
      : null

    const { data: pending, error: pendingErr } = await supabase
      .from("pending_actions")
      .insert({
        shop_id: shop.id,
        action_type: "send_sms",
        payload: {
          to_phone: lead.phone,
          body: draft,
          customer_name: lead.customer_name,
          customer_id: customer?.id ?? lead.customer_id ?? null,
          reason,
          source: "custom_agent",
          custom_agent_id: agent.id,
          lead_id: lead.id,
        },
        requested_by: agent.owner_id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[agent-runtime] pending insert failed:", pendingErr)
      continue
    }

    try {
      await sendSmsApprovalRequest({
        pendingActionId: pending.id,
        toPhone: lead.phone,
        customerName: lead.customer_name,
        body: draft,
        reason,
      })
    } catch (err) {
      console.error("[agent-runtime] Slack send failed:", err)
    }
    stats.proposed_sms += 1
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
  }
}

// ---------- recipe: appointment_reminder_email ----------

async function executeAppointmentReminderEmail(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow
): Promise<AgentRunOutcome> {
  const stats = {
    matched: 0,
    proposed_email: 0,
    skipped_no_email: 0,
    skipped_already_reminded: 0,
  }
  const recipe = agent.config.recipe
  if (!recipe || recipe.id !== "appointment_reminder_email") {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "recipe missing or wrong id",
    }
  }
  if (!shop.aurinko_access_token_enc) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "Gmail not connected via Aurinko",
    }
  }

  const { hours_before, window_hours } = recipe.params
  const now = Date.now()
  const targetMs = now + hours_before * HOUR_MS
  const lowerIso = new Date(targetMs - window_hours * HOUR_MS).toISOString()
  const upperIso = new Date(targetMs + window_hours * HOUR_MS).toISOString()

  const { data: apptRows, error: apptErr } = await supabase
    .from("appointments")
    .select("*, customer:customers(id, name, email, phone)")
    .eq("shop_id", shop.id)
    .gte("scheduled_at", lowerIso)
    .lte("scheduled_at", upperIso)
    .order("scheduled_at", { ascending: true })
    .limit(50)
  if (apptErr) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: `appointment query failed: ${apptErr.message}`,
    }
  }
  type JoinedAppt = AppointmentRow & {
    customer: Pick<CustomerRow, "id" | "name" | "email" | "phone"> | null
  }
  const appts = (apptRows as JoinedAppt[] | null) ?? []
  stats.matched = appts.length

  for (const appt of appts) {
    const email = appt.customer?.email?.trim()
    if (!email) {
      stats.skipped_no_email += 1
      continue
    }

    // Dedup by payload->appointment_id on existing pending send_emails
    // for this shop. Stripe-style upsert isn't an option (no unique
    // index) so we do a cheap exists-check.
    const { data: existing } = await supabase
      .from("pending_actions")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("action_type", "send_email")
      .eq("payload->>appointment_id", appt.id)
      .limit(1)
    if (existing && existing.length > 0) {
      stats.skipped_already_reminded += 1
      continue
    }

    const draft = await draftAppointmentReminderEmail({
      shopName: shop.name,
      customerName: appt.customer?.name ?? "there",
      service: appt.service_name,
      isoStartTime: appt.scheduled_at,
      timezone: appt.timezone,
      vehicle: null,
    }).catch(() => null)
    if (!draft) continue

    const reason = appt.service_name?.trim()
      ? `Reminder · ${appt.service_name.trim()}`
      : "Appointment reminder"

    const { data: pending, error: pendingErr } = await supabase
      .from("pending_actions")
      .insert({
        shop_id: shop.id,
        action_type: "send_email",
        payload: {
          to_email: email,
          subject: draft.subject,
          body: draft.body,
          customer_name: appt.customer?.name ?? null,
          customer_id: appt.customer?.id ?? null,
          reason,
          source: "custom_agent",
          custom_agent_id: agent.id,
          appointment_id: appt.id,
        },
        requested_by: agent.owner_id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[agent-runtime] email pending insert failed:", pendingErr)
      continue
    }

    try {
      await sendEmailApprovalRequest({
        pendingActionId: pending.id,
        toEmail: email,
        customerName: appt.customer?.name ?? null,
        subject: draft.subject,
        body: draft.body,
        reason,
      })
    } catch (err) {
      console.error("[agent-runtime] Slack send failed:", err)
    }
    stats.proposed_email += 1
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
  }
}

// ---------- recipe: stale_customer_sms ----------

async function executeStaleCustomerSms(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow
): Promise<AgentRunOutcome> {
  const stats = {
    matched: 0,
    proposed_sms: 0,
    skipped_no_phone: 0,
    skipped_cooldown: 0,
  }
  const recipe = agent.config.recipe
  if (!recipe || recipe.id !== "stale_customer_sms") {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "recipe missing or wrong id",
    }
  }
  if (!shop.twilio_phone_number) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "Twilio number not connected",
    }
  }

  const { inactive_days, cooldown_days } = recipe.params
  const inactiveCutoffIso = new Date(
    Date.now() - inactive_days * DAY_MS
  ).toISOString()
  const cooldownCutoffIso = new Date(
    Date.now() - cooldown_days * DAY_MS
  ).toISOString()

  // Step 1: find customers whose last interaction is older than the
  // inactivity threshold. Aggregating MAX(occurred_at) per customer in
  // Postgres is the right call here; from JS we do a select-order-cap.
  // For pilot scale (< few thousand customers/shop) this is fine.
  const { data: customerRows } = await supabase
    .from("customers")
    .select("id, name, phone")
    .eq("shop_id", shop.id)
    .not("phone", "is", null)
    .order("updated_at", { ascending: false })
    .limit(500)
  const candidates = (customerRows as Pick<CustomerRow, "id" | "name" | "phone">[] | null) ?? []
  if (candidates.length === 0) {
    return { agentId: agent.id, agentName: agent.name, fired: true, stats }
  }

  // Step 2: for each candidate, find max(occurred_at) on interactions
  // and the most recent outbound SMS we sent. Done as a single batch
  // query per condition.
  const ids = candidates.map((c) => c.id)
  const { data: recentRows } = await supabase
    .from("interactions")
    .select("customer_id, occurred_at")
    .eq("shop_id", shop.id)
    .in("customer_id", ids)
    .gt("occurred_at", inactiveCutoffIso)
  const recentSet = new Set(
    ((recentRows as { customer_id: string | null }[] | null) ?? [])
      .map((r) => r.customer_id)
      .filter((id): id is string => Boolean(id))
  )

  const { data: cooldownRows } = await supabase
    .from("interactions")
    .select("customer_id, occurred_at, role, channel, metadata")
    .eq("shop_id", shop.id)
    .eq("role", "gradia")
    .eq("channel", "sms")
    .in("customer_id", ids)
    .gt("occurred_at", cooldownCutoffIso)
  const cooldownSet = new Set(
    ((cooldownRows as { customer_id: string | null }[] | null) ?? [])
      .map((r) => r.customer_id)
      .filter((id): id is string => Boolean(id))
  )

  for (const customer of candidates) {
    if (recentSet.has(customer.id)) continue // not actually stale
    if (!customer.phone) {
      stats.skipped_no_phone += 1
      continue
    }
    if (cooldownSet.has(customer.id)) {
      stats.skipped_cooldown += 1
      continue
    }
    stats.matched += 1

    const draft = await draftCustomSmsForCustomer({
      shopName: shop.name,
      customerName: customer.name ?? "there",
      vehicle: null,
      service: null,
      intent: agent.config.action.intent_summary,
    }).catch(() => null)
    if (!draft) continue

    const reason = `Custom agent · ${agent.name}`

    const { data: pending, error: pendingErr } = await supabase
      .from("pending_actions")
      .insert({
        shop_id: shop.id,
        action_type: "send_sms",
        payload: {
          to_phone: customer.phone,
          body: draft,
          customer_name: customer.name,
          customer_id: customer.id,
          reason,
          source: "custom_agent",
          custom_agent_id: agent.id,
        },
        requested_by: agent.owner_id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[agent-runtime] stale-sms pending insert failed:", pendingErr)
      continue
    }

    try {
      await sendSmsApprovalRequest({
        pendingActionId: pending.id,
        toPhone: customer.phone,
        customerName: customer.name,
        body: draft,
        reason,
      })
    } catch (err) {
      console.error("[agent-runtime] Slack send failed:", err)
    }
    stats.proposed_sms += 1
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
  }
}

// ---------- event-driven recipe handlers ----------

// Lazy-imports kept inline so this module doesn't grab the email
// drafter unless an event recipe actually runs.
import type { AgentEvent } from "@/lib/agent-events"
import { draftCustomEmailForCustomer } from "@/lib/email-drafter"
import { sendEmailApprovalRequest as _sendEmailApprovalRequest } from "@/lib/slack"

async function executePaymentReceivedThankYouSms(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow,
  event: AgentEvent
): Promise<AgentRunOutcome> {
  if (event.kind !== "payment_received") {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "wrong event kind",
    }
  }
  if (!shop.twilio_phone_number) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "Twilio number not connected",
    }
  }
  if (!event.customerPhone) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "no phone on file for the paying customer",
    }
  }

  const intent =
    agent.config.action.intent_summary?.trim() ||
    "Thank them for paying and let them know we appreciate the business."

  const draft = await draftCustomSmsForCustomer({
    shopName: shop.name,
    customerName: event.customerName ?? "there",
    vehicle: null,
    service: null,
    intent: `${intent}\n\nContext: They just paid $${(event.amountCents / 100).toFixed(2)}.`,
  }).catch(() => null)
  if (!draft) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "drafter returned no message",
    }
  }

  const reason = `Custom agent · ${agent.name}`
  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "send_sms",
      payload: {
        to_phone: event.customerPhone,
        body: draft,
        customer_name: event.customerName,
        customer_id: event.customerId,
        reason,
        source: "custom_agent_event",
        custom_agent_id: agent.id,
        event_kind: event.kind,
        stripe_invoice_id: event.stripeInvoiceId,
      },
      requested_by: agent.owner_id,
    })
    .select("id")
    .single()
  if (pendingErr || !pending) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: `pending insert failed: ${pendingErr?.message ?? "unknown"}`,
    }
  }

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: event.customerPhone,
      customerName: event.customerName,
      body: draft,
      reason,
    })
  } catch (err) {
    console.error("[agent-runtime] thank-you Slack send failed:", err)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats: { proposed_sms: 1 },
  }
}

async function executeBookingApprovedPrepEmail(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow,
  event: AgentEvent
): Promise<AgentRunOutcome> {
  if (event.kind !== "booking_approved") {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "wrong event kind",
    }
  }
  if (!shop.aurinko_access_token_enc) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "Gmail not connected via Aurinko",
    }
  }
  if (!event.customerEmail) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "no email on file for the booked customer",
    }
  }

  const intent =
    agent.config.action.intent_summary?.trim() ||
    "Send a brief pre-appointment note with anything they should know before we see them."

  const whenText = (() => {
    try {
      return new Date(event.isoStartTime).toLocaleString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: event.timezone ?? undefined,
      })
    } catch {
      return event.isoStartTime
    }
  })()

  const draft = await draftCustomEmailForCustomer({
    shopName: shop.name,
    customerName: event.customerName,
    service: event.serviceName,
    when: whenText,
    intent,
  }).catch(() => null)
  if (!draft) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "drafter returned no email",
    }
  }

  const reason = `Custom agent · ${agent.name}`
  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "send_email",
      payload: {
        to_email: event.customerEmail,
        subject: draft.subject,
        body: draft.body,
        customer_name: event.customerName,
        customer_id: event.customerId,
        reason,
        source: "custom_agent_event",
        custom_agent_id: agent.id,
        event_kind: event.kind,
        appointment_id: event.appointmentId,
      },
      requested_by: agent.owner_id,
    })
    .select("id")
    .single()
  if (pendingErr || !pending) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: `pending insert failed: ${pendingErr?.message ?? "unknown"}`,
    }
  }

  try {
    await _sendEmailApprovalRequest({
      pendingActionId: pending.id,
      toEmail: event.customerEmail,
      customerName: event.customerName,
      subject: draft.subject,
      body: draft.body,
      reason,
    })
  } catch (err) {
    console.error("[agent-runtime] prep-email Slack send failed:", err)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats: { proposed_email: 1 },
  }
}

// ---------- recipe dispatch ----------

type RecipeHandler = (
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow
) => Promise<AgentRunOutcome>

type EventRecipeHandler = (
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow,
  event: AgentEvent
) => Promise<AgentRunOutcome>

const RECIPE_HANDLERS: Record<string, RecipeHandler> = {
  lead_followup_sms: executeLeadFollowupSms,
  appointment_reminder_email: executeAppointmentReminderEmail,
  stale_customer_sms: executeStaleCustomerSms,
}

const EVENT_RECIPE_HANDLERS: Record<string, EventRecipeHandler> = {
  payment_received_thank_you_sms: executePaymentReceivedThankYouSms,
  booking_approved_prep_email: executeBookingApprovedPrepEmail,
}

/**
 * Entry point used by agent-events.dispatchAgentEvent. Looks up the
 * matching handler by recipe id and runs it. Errors swallowed —
 * caller logs.
 */
export async function runEventRecipe(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow,
  event: AgentEvent
): Promise<AgentRunOutcome> {
  const recipeId = agent.config.recipe?.id
  if (!recipeId) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "no recipe on this agent",
    }
  }
  const handler = EVENT_RECIPE_HANDLERS[recipeId]
  if (!handler) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: `unknown event recipe: ${recipeId}`,
    }
  }
  return handler(supabase, shop, agent, event)
}

async function loadShop(
  supabase: SupabaseClient,
  shopId: string
): Promise<ShopRow | null> {
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopId)
    .maybeSingle()
  return (data as ShopRow | null) ?? null
}

/**
 * One-shot fire of a single agent. Used by the "Run now" button.
 * Bypasses the cadence check — the operator explicitly asked.
 */
export async function runCustomAgent(
  supabase: SupabaseClient,
  agent: CustomAgentRow
): Promise<AgentRunOutcome> {
  const recipeId = agent.config.recipe?.id
  if (!recipeId) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "no runnable recipe on this plan",
    }
  }
  const handler = RECIPE_HANDLERS[recipeId]
  if (!handler) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: `unknown recipe id: ${recipeId}`,
    }
  }
  const shop = await loadShop(supabase, agent.shop_id)
  if (!shop) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "shop not found",
    }
  }
  const outcome = await handler(supabase, shop, agent)
  if (outcome.fired) await stampFired(supabase, agent.id, agent.shop_id)
  return outcome
}

/**
 * Cron tick. Iterates every enabled custom agent and fires the ones
 * whose schedule is open AND haven't fired within their minimum gap.
 * Errors per-agent are caught so one bad recipe can't poison the rest.
 */
export async function runScheduledAgents(
  supabase: SupabaseClient
): Promise<{ considered: number; fired: number; outcomes: AgentRunOutcome[] }> {
  const now = new Date()
  const { data, error } = await supabase
    .from("custom_agents")
    .select("*")
    .eq("enabled", true)
  if (error) {
    throw new Error(`runScheduledAgents query failed: ${error.message}`)
  }
  const agents = (data as CustomAgentRow[] | null) ?? []

  const outcomes: AgentRunOutcome[] = []
  let fired = 0

  // Cache shop loads — many shops may have multiple agents.
  const shopCache = new Map<string, ShopRow | null>()
  async function getShop(shopId: string): Promise<ShopRow | null> {
    if (!shopCache.has(shopId)) {
      shopCache.set(shopId, await loadShop(supabase, shopId))
    }
    return shopCache.get(shopId) ?? null
  }

  for (const agent of agents) {
    try {
      const recipeId = agent.config.recipe?.id
      if (!recipeId) {
        outcomes.push({
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: "no recipe",
        })
        continue
      }
      const handler = RECIPE_HANDLERS[recipeId]
      if (!handler) {
        outcomes.push({
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: `unknown recipe: ${recipeId}`,
        })
        continue
      }
      const decision = shouldFireOnSchedule(agent, now)
      if (!decision.fire) {
        outcomes.push({
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: decision.reason,
        })
        continue
      }
      const shop = await getShop(agent.shop_id)
      if (!shop) {
        outcomes.push({
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: "shop missing",
        })
        continue
      }
      const outcome = await handler(supabase, shop, agent)
      if (outcome.fired) {
        await stampFired(supabase, agent.id, agent.shop_id)
        fired += 1
      }
      outcomes.push(outcome)
    } catch (err) {
      console.error("[agent-runtime] agent crashed:", agent.id, err)
      outcomes.push({
        agentId: agent.id,
        agentName: agent.name,
        fired: false,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { considered: agents.length, fired, outcomes }
}

