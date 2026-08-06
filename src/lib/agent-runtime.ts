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

import { looksOptedOut, resolveFreeformAudience } from "@/lib/agent-audience"
import { recordAgentRun, type TriggerSource } from "@/lib/agent-runs"
import { isAutonomyAllowed, resolveAgentMode } from "@/lib/autonomy"
import { isOverCreditLimit, recordUsage } from "@/lib/credits"
import { recordActionDecision } from "@/lib/decision-log"
import { buildDrafterGrounding } from "@/lib/drafting-context"
import { hasPackage2, isPaid } from "@/lib/entitlements"
import { getReviewLink } from "@/lib/review-link"
import {
  draftReviewRequestEmail,
  draftReviewRequestSms,
} from "@/lib/review-request"
import { recordApprovalResolution } from "@/lib/trust"
import { getPricing, priceUsage } from "@/lib/pricing"
import { findCustomerByChannel } from "@/lib/customers"
import { draftAppointmentReminderEmail } from "@/lib/email-drafter"
import { FEATURES } from "@/lib/features"
import {
  sendEmailApprovalRequest,
  sendSmsApprovalRequest,
} from "@/lib/slack"
import { verifierPayloadFragment, verifyDraft } from "@/lib/draft-verifier"
import {
  draftAppointmentReminderSms,
  draftCustomSmsForCustomer,
} from "@/lib/sms-drafter"
import type {
  AgentConfig,
  AppointmentRow,
  CustomAgentRow,
  CustomerRow,
  FreeformPlan,
  LeadRow,
  PendingActionType,
  ServiceRow,
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
  /** Pending action ids this run produced — surfaced as deep links in
   *  the run-history UI so operators can jump straight to the
   *  generated approvals. */
  pendingActionIds?: string[]
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
  const pendingActionIds: string[] = []
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
          ...(await verifyBeforeStaging(supabase, shop, {
            channel: "sms",
            body: draft,
            customerName: lead.customer_name,
          })),
        },
        requested_by: agent.owner_id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[agent-runtime] pending insert failed:", pendingErr)
      continue
    }

    // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
    await recordActionDecision(supabase, {
      shopId: shop.id,
      pendingActionId: pending.id,
      source: "custom_agent",
      because: `Staged a follow-up because this lead has been "${status}" for ${min_lead_age_days}+ days with no reply in the last ${no_inbound_within_days} days.`,
      inputs: {
        rule: "lead_followup_sms",
        custom_agent_id: agent.id,
        lead_id: lead.id,
        lead_status: status,
        min_lead_age_days,
        no_inbound_within_days,
      },
    })

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
    pendingActionIds.push(pending.id)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
    pendingActionIds,
  }
}

// ---------- cross-model draft verification (sharpening brief P1) ----------

/** Per-process service-menu cache — one fetch per shop per cron tick. */
const serviceMenuCache = new Map<
  string,
  Pick<ServiceRow, "name" | "price_cents">[]
>()

async function serviceMenuFor(
  supabase: SupabaseClient,
  shopId: string
): Promise<Pick<ServiceRow, "name" | "price_cents">[]> {
  const cached = serviceMenuCache.get(shopId)
  if (cached) return cached
  const { data } = await supabase
    .from("services")
    .select("name, price_cents")
    .eq("shop_id", shopId)
  const menu = (data as Pick<ServiceRow, "name" | "price_cents">[] | null) ?? []
  serviceMenuCache.set(shopId, menu)
  return menu
}

/**
 * Runs the separate critic over a draft about to be staged and returns
 * the payload fragment to merge in: empty when clean, a `verifier` flag
 * with objections when not. Never throws, never blocks staging.
 */
async function verifyBeforeStaging(
  supabase: SupabaseClient,
  shop: ShopRow,
  draft: {
    channel: "sms" | "email"
    body: string
    subject?: string | null
    customerName?: string | null
  }
): Promise<Record<string, unknown>> {
  const result = await verifyDraft({
    channel: draft.channel,
    body: draft.body,
    subject: draft.subject ?? null,
    customerName: draft.customerName ?? null,
    shopName: shop.name,
    services: await serviceMenuFor(supabase, shop.id),
  })
  if (!result.pass) {
    console.warn(
      `[agent-runtime] verifier flagged a ${draft.channel} draft for ${shop.id}:`,
      result.objections
    )
  }
  return verifierPayloadFragment(result)
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
  const pendingActionIds: string[] = []
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
          ...(await verifyBeforeStaging(supabase, shop, {
            channel: "email",
            body: draft.body,
            subject: draft.subject,
            customerName: appt.customer?.name ?? null,
          })),
        },
        requested_by: agent.owner_id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[agent-runtime] email pending insert failed:", pendingErr)
      continue
    }

    // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
    await recordActionDecision(supabase, {
      shopId: shop.id,
      pendingActionId: pending.id,
      source: "custom_agent",
      because: `Staged a reminder because the ${appt.service_name?.trim() || "appointment"} is coming up and no reminder email had been sent yet.`,
      inputs: {
        rule: "appointment_reminder_email",
        custom_agent_id: agent.id,
        appointment_id: appt.id,
        scheduled_at: appt.scheduled_at,
      },
    })

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
    pendingActionIds.push(pending.id)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
    pendingActionIds,
  }
}

// ---------- recipe: appointment_reminder_sms ----------

/**
 * SMS twin of the email reminder (work order item 3). Same window logic;
 * differences: requires a phone + the shop's SMS line, honors STOP
 * opt-outs before staging (compliance — never draft to an opted-out
 * customer), and stages send_sms approvals. HITL as always.
 */
async function executeAppointmentReminderSms(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow
): Promise<AgentRunOutcome> {
  const stats = {
    matched: 0,
    proposed_sms: 0,
    skipped_no_phone: 0,
    skipped_already_reminded: 0,
    skipped_opted_out: 0,
  }
  const pendingActionIds: string[] = []
  const recipe = agent.config.recipe
  if (!recipe || recipe.id !== "appointment_reminder_sms") {
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
      reason: "no SMS number connected",
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
    const phone = appt.customer?.phone?.trim()
    if (!phone) {
      stats.skipped_no_phone += 1
      continue
    }

    // STOP compliance: never stage to a customer who opted out.
    if (appt.customer?.id) {
      const { data: inbound } = await supabase
        .from("interactions")
        .select("content")
        .eq("shop_id", shop.id)
        .eq("role", "customer")
        .eq("customer_id", appt.customer.id)
        .order("created_at", { ascending: false })
        .limit(20)
      const optedOut = (
        (inbound as { content: string }[] | null) ?? []
      ).some((r) => looksOptedOut(r.content))
      if (optedOut) {
        stats.skipped_opted_out += 1
        continue
      }
    }

    // Dedup: one reminder SMS per appointment.
    const { data: existing } = await supabase
      .from("pending_actions")
      .select("id")
      .eq("shop_id", shop.id)
      .eq("action_type", "send_sms")
      .eq("payload->>appointment_id", appt.id)
      .limit(1)
    if (existing && existing.length > 0) {
      stats.skipped_already_reminded += 1
      continue
    }

    const body = await draftAppointmentReminderSms({
      shopName: shop.name,
      customerName: appt.customer?.name ?? "there",
      service: appt.service_name,
      isoStartTime: appt.scheduled_at,
      timezone: appt.timezone,
      vehicle: null,
    }).catch(() => null)
    if (!body) continue

    const reason = appt.service_name?.trim()
      ? `Reminder · ${appt.service_name.trim()}`
      : "Appointment reminder"

    const { data: pending, error: pendingErr } = await supabase
      .from("pending_actions")
      .insert({
        shop_id: shop.id,
        action_type: "send_sms",
        payload: {
          to_phone: phone,
          body,
          customer_name: appt.customer?.name ?? null,
          customer_id: appt.customer?.id ?? null,
          reason,
          source: "custom_agent",
          custom_agent_id: agent.id,
          appointment_id: appt.id,
          ...(await verifyBeforeStaging(supabase, shop, {
            channel: "sms",
            body,
            customerName: appt.customer?.name ?? null,
          })),
        },
        requested_by: agent.owner_id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[agent-runtime] sms reminder insert failed:", pendingErr)
      continue
    }

    // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
    await recordActionDecision(supabase, {
      shopId: shop.id,
      pendingActionId: pending.id,
      source: "custom_agent",
      because: `Staged a reminder because the ${appt.service_name?.trim() || "appointment"} is coming up and no reminder text had been sent yet.`,
      inputs: {
        rule: "appointment_reminder_sms",
        custom_agent_id: agent.id,
        appointment_id: appt.id,
        scheduled_at: appt.scheduled_at,
      },
    })

    try {
      await sendSmsApprovalRequest({
        pendingActionId: pending.id,
        toPhone: phone,
        customerName: appt.customer?.name ?? null,
        body,
        reason,
      })
    } catch (err) {
      console.error("[agent-runtime] Slack send failed:", err)
    }
    stats.proposed_sms += 1
    pendingActionIds.push(pending.id)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
    pendingActionIds,
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
  const pendingActionIds: string[] = []
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
          ...(await verifyBeforeStaging(supabase, shop, {
            channel: "sms",
            body: draft,
            customerName: customer.name,
          })),
        },
        requested_by: agent.owner_id,
      })
      .select("id")
      .single()

    if (pendingErr || !pending) {
      console.error("[agent-runtime] stale-sms pending insert failed:", pendingErr)
      continue
    }

    // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
    await recordActionDecision(supabase, {
      shopId: shop.id,
      pendingActionId: pending.id,
      source: "custom_agent",
      because: `Staged a check-in because there's been no contact with ${customer.name || "this customer"} in ${inactive_days}+ days and no outreach in the last ${cooldown_days} days.`,
      inputs: {
        rule: "stale_customer_sms",
        custom_agent_id: agent.id,
        customer_id: customer.id,
        inactive_days,
        cooldown_days,
      },
    })

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
    pendingActionIds.push(pending.id)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
    pendingActionIds,
  }
}

// ---------- recipe: freeform_outreach (hybrid Chat agent) ----------

/**
 * Runs a free-form plan: resolve the (guardrailed) audience, draft a
 * per-recipient message in our voice, and stage each as a pending_actions
 * approval. NEVER sends directly — every message is HITL-gated, exactly like
 * the coded recipes. Audience resolution (cap, cooldown, opt-out, no-inbound,
 * inactivity) lives in lib/agent-audience.ts.
 */
async function executeFreeformOutreach(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow
): Promise<AgentRunOutcome> {
  const plan = agent.config.freeform
  if (!plan) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "no free-form plan on this agent",
    }
  }
  if (plan.channel === "sms" && !shop.twilio_phone_number) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "Twilio number not connected",
    }
  }
  if (plan.channel === "email" && !shop.aurinko_access_token_enc) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "Gmail not connected via Aurinko",
    }
  }

  let audience
  try {
    audience = await resolveFreeformAudience(supabase, shop, plan)
  } catch (err) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: err instanceof Error ? err.message : "audience resolve failed",
    }
  }
  if (audience.blocked) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: audience.blocked,
    }
  }

  const stats: Record<string, number> = {
    matched: audience.stats.candidates,
    proposed: 0,
    skipped_no_contact: audience.stats.skipped_no_contact,
    skipped_active: audience.stats.skipped_active,
    skipped_recent_inbound: audience.stats.skipped_recent_inbound,
    skipped_cooldown: audience.stats.skipped_cooldown,
    skipped_opted_out: audience.stats.skipped_opted_out,
    draft_failed: 0,
  }
  const pendingActionIds: string[] = []
  const reason = `Custom agent · ${agent.name}`
  const grounding = await buildDrafterGrounding(supabase, shop.id)

  for (const t of audience.targets) {
    if (plan.channel === "sms") {
      if (!t.phone) continue
      const body = await draftCustomSmsForCustomer({
        shopName: shop.name,
        customerName: t.name ?? "there",
        vehicle: t.vehicle,
        service: t.service,
        intent: plan.message_intent,
        knowledge: grounding,
      }).catch(() => null)
      if (!body) {
        stats.draft_failed += 1
        continue
      }

      const { data: pending, error: pendingErr } = await supabase
        .from("pending_actions")
        .insert({
          shop_id: shop.id,
          action_type: "send_sms",
          payload: {
            to_phone: t.phone,
            body,
            customer_name: t.name,
            customer_id: t.customerId,
            reason,
            source: "custom_agent",
            category: "marketing",
            custom_agent_id: agent.id,
            lead_id: t.leadId,
            ...(await verifyBeforeStaging(supabase, shop, {
              channel: "sms",
              body,
              customerName: t.name,
            })),
          },
          requested_by: agent.owner_id,
        })
        .select("id")
        .single()
      if (pendingErr || !pending) {
        console.error("[agent-runtime] freeform sms insert failed:", pendingErr)
        continue
      }
      // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
      await recordActionDecision(supabase, {
        shopId: shop.id,
        pendingActionId: pending.id,
        source: "custom_agent",
        because: `Staged because they matched this agent's ${plan.entity} audience for: ${plan.message_intent}`,
        inputs: {
          rule: "freeform_outreach",
          custom_agent_id: agent.id,
          channel: plan.channel,
          entity: plan.entity,
          filters: plan.filters,
          message_intent: plan.message_intent,
          lead_id: t.leadId ?? null,
          customer_id: t.customerId ?? null,
        },
      })
      try {
        await sendSmsApprovalRequest({
          pendingActionId: pending.id,
          toPhone: t.phone,
          customerName: t.name,
          body,
          reason,
        })
      } catch (err) {
        console.error("[agent-runtime] freeform Slack send failed:", err)
      }
      stats.proposed += 1
      pendingActionIds.push(pending.id)
    } else {
      if (!t.email) continue
      const draft = await draftCustomEmailForCustomer({
        shopName: shop.name,
        customerName: t.name ?? "there",
        service: t.service,
        when: null,
        intent: plan.message_intent,
        knowledge: grounding,
      }).catch(() => null)
      if (!draft) {
        stats.draft_failed += 1
        continue
      }

      const { data: pending, error: pendingErr } = await supabase
        .from("pending_actions")
        .insert({
          shop_id: shop.id,
          action_type: "send_email",
          payload: {
            to_email: t.email,
            subject: draft.subject,
            body: draft.body,
            customer_name: t.name,
            customer_id: t.customerId,
            reason,
            source: "custom_agent",
            custom_agent_id: agent.id,
            ...(await verifyBeforeStaging(supabase, shop, {
              channel: "email",
              body: draft.body,
              subject: draft.subject,
              customerName: t.name,
            })),
          },
          requested_by: agent.owner_id,
        })
        .select("id")
        .single()
      if (pendingErr || !pending) {
        console.error(
          "[agent-runtime] freeform email insert failed:",
          pendingErr
        )
        continue
      }
      // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
      await recordActionDecision(supabase, {
        shopId: shop.id,
        pendingActionId: pending.id,
        source: "custom_agent",
        because: `Staged because they matched this agent's ${plan.entity} audience for: ${plan.message_intent}`,
        inputs: {
          rule: "freeform_outreach",
          custom_agent_id: agent.id,
          channel: plan.channel,
          entity: plan.entity,
          filters: plan.filters,
          message_intent: plan.message_intent,
          customer_id: t.customerId ?? null,
        },
      })
      try {
        await sendEmailApprovalRequest({
          pendingActionId: pending.id,
          toEmail: t.email,
          customerName: t.name,
          subject: draft.subject,
          body: draft.body,
          reason,
        })
      } catch (err) {
        console.error("[agent-runtime] freeform Slack send failed:", err)
      }
      stats.proposed += 1
      pendingActionIds.push(pending.id)
    }
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats,
    pendingActionIds,
  }
}

export type OutreachStageSource = {
  /** "gradia_agent" (owner box) or "custom_agent" (scheduled). */
  source: string
  /** Human label on each pending_action (e.g. "Gradia Agent · text Tesla owners"). */
  reason: string
  /** User id recorded as requested_by on each pending_action. */
  requestedBy: string
  /** Set for scheduled custom agents; null for the owner box. */
  customAgentId?: string | null
}

export type OutreachStageResult = {
  staged: number
  pendingActionIds: string[]
  stats: Record<string, number>
  blocked?: string
}

/**
 * Execution layer for outreach — resolves a FreeformPlan's guardrail-filtered
 * audience and STAGES a per-recipient send_sms/send_email into pending_actions.
 * NEVER sends: every row lands in /approvals for the human gate. The Gradia
 * Agent conversation loop calls this only after the owner confirms in chat
 * (the loop itself has no send tool — locked principle #1/#2).
 *
 * Mirrors the staging in executeFreeformOutreach (the scheduled path); the two
 * can be consolidated onto this once the scheduled executor is migrated.
 */
export async function stageOutreachPlan(
  supabase: SupabaseClient,
  shop: ShopRow,
  plan: FreeformPlan,
  src: OutreachStageSource
): Promise<OutreachStageResult> {
  // Shadow Mode — bulk staging is suppressed wholesale while simulating.
  if (shop.simulation_mode) {
    return {
      staged: 0,
      pendingActionIds: [],
      stats: {},
      blocked: "Shadow Mode is on — nothing was staged.",
    }
  }
  let audience
  try {
    audience = await resolveFreeformAudience(supabase, shop, plan)
  } catch (err) {
    return {
      staged: 0,
      pendingActionIds: [],
      stats: {},
      blocked: err instanceof Error ? err.message : "audience resolve failed",
    }
  }
  if (audience.blocked) {
    return { staged: 0, pendingActionIds: [], stats: {}, blocked: audience.blocked }
  }

  const stats: Record<string, number> = {
    matched: audience.stats.candidates,
    proposed: 0,
    skipped_no_contact: audience.stats.skipped_no_contact,
    skipped_active: audience.stats.skipped_active,
    skipped_recent_inbound: audience.stats.skipped_recent_inbound,
    skipped_cooldown: audience.stats.skipped_cooldown,
    skipped_opted_out: audience.stats.skipped_opted_out,
    draft_failed: 0,
  }
  const pendingActionIds: string[] = []
  const { source, reason, requestedBy, customAgentId = null } = src
  const grounding = await buildDrafterGrounding(supabase, shop.id)

  for (const t of audience.targets) {
    if (plan.channel === "sms") {
      if (!t.phone) continue
      const body = await draftCustomSmsForCustomer({
        shopName: shop.name,
        customerName: t.name ?? "there",
        vehicle: t.vehicle,
        service: t.service,
        intent: plan.message_intent,
        knowledge: grounding,
      }).catch(() => null)
      if (!body) {
        stats.draft_failed += 1
        continue
      }
      const { data: pending, error: pendingErr } = await supabase
        .from("pending_actions")
        .insert({
          shop_id: shop.id,
          action_type: "send_sms",
          payload: {
            to_phone: t.phone,
            body,
            customer_name: t.name,
            customer_id: t.customerId,
            reason,
            source,
            category: "marketing",
            custom_agent_id: customAgentId,
            lead_id: t.leadId,
            ...(await verifyBeforeStaging(supabase, shop, {
              channel: "sms",
              body,
              customerName: t.name,
            })),
          },
          requested_by: requestedBy,
        })
        .select("id")
        .single()
      if (pendingErr || !pending) {
        console.error("[agent-runtime] outreach sms insert failed:", pendingErr)
        continue
      }
      // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
      await recordActionDecision(supabase, {
        shopId: shop.id,
        pendingActionId: pending.id,
        source,
        because: `Staged because they matched the requested ${plan.entity} audience for: ${plan.message_intent}`,
        inputs: {
          rule: "outreach_plan",
          custom_agent_id: customAgentId,
          request_label: reason,
          channel: plan.channel,
          entity: plan.entity,
          filters: plan.filters,
          message_intent: plan.message_intent,
          lead_id: t.leadId ?? null,
          customer_id: t.customerId ?? null,
        },
      })
      try {
        await sendSmsApprovalRequest({
          pendingActionId: pending.id,
          toPhone: t.phone,
          customerName: t.name,
          body,
          reason,
        })
      } catch (err) {
        console.error("[agent-runtime] outreach Slack send failed:", err)
      }
      stats.proposed += 1
      pendingActionIds.push(pending.id)
    } else {
      if (!t.email) continue
      const draft = await draftCustomEmailForCustomer({
        shopName: shop.name,
        customerName: t.name ?? "there",
        service: t.service,
        when: null,
        intent: plan.message_intent,
        knowledge: grounding,
      }).catch(() => null)
      if (!draft) {
        stats.draft_failed += 1
        continue
      }
      const { data: pending, error: pendingErr } = await supabase
        .from("pending_actions")
        .insert({
          shop_id: shop.id,
          action_type: "send_email",
          payload: {
            to_email: t.email,
            subject: draft.subject,
            body: draft.body,
            customer_name: t.name,
            customer_id: t.customerId,
            reason,
            source,
            custom_agent_id: customAgentId,
            ...(await verifyBeforeStaging(supabase, shop, {
              channel: "email",
              body: draft.body,
              subject: draft.subject,
              customerName: t.name,
            })),
          },
          requested_by: requestedBy,
        })
        .select("id")
        .single()
      if (pendingErr || !pending) {
        console.error("[agent-runtime] outreach email insert failed:", pendingErr)
        continue
      }
      // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
      await recordActionDecision(supabase, {
        shopId: shop.id,
        pendingActionId: pending.id,
        source,
        because: `Staged because they matched the requested ${plan.entity} audience for: ${plan.message_intent}`,
        inputs: {
          rule: "outreach_plan",
          custom_agent_id: customAgentId,
          request_label: reason,
          channel: plan.channel,
          entity: plan.entity,
          filters: plan.filters,
          message_intent: plan.message_intent,
          customer_id: t.customerId ?? null,
        },
      })
      try {
        await sendEmailApprovalRequest({
          pendingActionId: pending.id,
          toEmail: t.email,
          customerName: t.name,
          subject: draft.subject,
          body: draft.body,
          reason,
        })
      } catch (err) {
        console.error("[agent-runtime] outreach Slack send failed:", err)
      }
      stats.proposed += 1
      pendingActionIds.push(pending.id)
    }
  }

  return { staged: stats.proposed, pendingActionIds, stats }
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
        ...(await verifyBeforeStaging(supabase, shop, {
          channel: "sms",
          body: draft,
          customerName: event.customerName,
        })),
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

  // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
  await recordActionDecision(supabase, {
    shopId: shop.id,
    pendingActionId: pending.id,
    source: "custom_agent_event",
    because: `Staged a thank-you because their payment of $${(event.amountCents / 100).toFixed(2)} was received.`,
    inputs: {
      rule: "payment_received_thank_you_sms",
      custom_agent_id: agent.id,
      event_kind: event.kind,
      stripe_invoice_id: event.stripeInvoiceId ?? null,
      amount_cents: event.amountCents,
    },
  })

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
    pendingActionIds: [pending.id],
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
        ...(await verifyBeforeStaging(supabase, shop, {
          channel: "email",
          body: draft.body,
          subject: draft.subject,
          customerName: event.customerName,
        })),
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

  // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
  await recordActionDecision(supabase, {
    shopId: shop.id,
    pendingActionId: pending.id,
    source: "custom_agent_event",
    because: `Staged a prep note because their ${event.serviceName?.trim() || "appointment"} was booked for ${whenText}.`,
    inputs: {
      rule: "booking_approved_prep_email",
      custom_agent_id: agent.id,
      event_kind: event.kind,
      appointment_id: event.appointmentId ?? null,
      iso_start_time: event.isoStartTime,
    },
  })

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
    pendingActionIds: [pending.id],
  }
}

/**
 * Post-job review request (NEXT-1). Fires on payment_received. Sends the SAME
 * neutral ask to every paying customer with the shop's review link — no
 * sentiment-gating (FTC / Google policy). Category is "marketing", so the
 * send-policy still requires consent or an established business relationship
 * (a paid customer has one). HITL always.
 */
async function executeReviewRequestSms(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow,
  event: AgentEvent
): Promise<AgentRunOutcome> {
  const no = (reason: string): AgentRunOutcome => ({
    agentId: agent.id,
    agentName: agent.name,
    fired: false,
    reason,
  })
  if (event.kind !== "payment_received") return no("wrong event kind")
  if (!shop.twilio_phone_number) return no("Twilio number not connected")
  if (!event.customerPhone) return no("no phone on file for the paying customer")
  const reviewLink = getReviewLink(shop)
  if (!reviewLink) return no("no review link set (Settings → Reviews)")

  const grounding = await buildDrafterGrounding(supabase, shop.id)
  const draft = await draftReviewRequestSms({
    shopName: shop.name,
    customerName: event.customerName ?? "there",
    reviewLink,
    knowledge: grounding,
  }).catch(() => null)
  if (!draft) return no("drafter returned no message")

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
        source: "review_request",
        category: "marketing",
        custom_agent_id: agent.id,
        event_kind: event.kind,
        ...(await verifyBeforeStaging(supabase, shop, {
          channel: "sms",
          body: draft,
          customerName: event.customerName,
        })),
      },
      requested_by: agent.owner_id,
    })
    .select("id")
    .single()
  if (pendingErr || !pending) {
    return no(`pending insert failed: ${pendingErr?.message ?? "unknown"}`)
  }

  // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
  await recordActionDecision(supabase, {
    shopId: shop.id,
    pendingActionId: pending.id,
    source: "review_request",
    because:
      "Staged a review request because their payment was received — every paying customer gets the same ask, no cherry-picking.",
    inputs: {
      rule: "review_request_sms",
      custom_agent_id: agent.id,
      event_kind: event.kind,
    },
  })

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: event.customerPhone,
      customerName: event.customerName,
      body: draft,
      reason,
    })
  } catch (err) {
    console.error("[agent-runtime] review-request Slack send failed:", err)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats: { proposed_sms: 1 },
    pendingActionIds: [pending.id],
  }
}

/** Email variant of the post-job review request (NEXT-1). */
async function executeReviewRequestEmail(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow,
  event: AgentEvent
): Promise<AgentRunOutcome> {
  const no = (reason: string): AgentRunOutcome => ({
    agentId: agent.id,
    agentName: agent.name,
    fired: false,
    reason,
  })
  if (event.kind !== "payment_received") return no("wrong event kind")
  if (!shop.aurinko_access_token_enc) return no("Gmail not connected via Aurinko")
  if (!event.customerEmail) return no("no email on file for the paying customer")
  const reviewLink = getReviewLink(shop)
  if (!reviewLink) return no("no review link set (Settings → Reviews)")

  const grounding = await buildDrafterGrounding(supabase, shop.id)
  const draft = await draftReviewRequestEmail({
    shopName: shop.name,
    customerName: event.customerName ?? "there",
    reviewLink,
    knowledge: grounding,
  }).catch(() => null)
  if (!draft) return no("drafter returned no email")

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
        source: "review_request",
        category: "marketing",
        custom_agent_id: agent.id,
        event_kind: event.kind,
        ...(await verifyBeforeStaging(supabase, shop, {
          channel: "email",
          body: draft.body,
          subject: draft.subject,
          customerName: event.customerName,
        })),
      },
      requested_by: agent.owner_id,
    })
    .select("id")
    .single()
  if (pendingErr || !pending) {
    return no(`pending insert failed: ${pendingErr?.message ?? "unknown"}`)
  }

  // Glass Box decision log (spec §8-A6b) — best-effort, never throws.
  await recordActionDecision(supabase, {
    shopId: shop.id,
    pendingActionId: pending.id,
    source: "review_request",
    because:
      "Staged a review request because their payment was received — every paying customer gets the same ask, no cherry-picking.",
    inputs: {
      rule: "review_request_email",
      custom_agent_id: agent.id,
      event_kind: event.kind,
    },
  })

  try {
    await sendEmailApprovalRequest({
      pendingActionId: pending.id,
      toEmail: event.customerEmail,
      customerName: event.customerName,
      subject: draft.subject,
      body: draft.body,
      reason,
    })
  } catch (err) {
    console.error("[agent-runtime] review-request email Slack send failed:", err)
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    fired: true,
    stats: { proposed_email: 1 },
    pendingActionIds: [pending.id],
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

/** Exported for the eval harness — recipes ship gated on tests (#6). */
export const RECIPE_HANDLERS: Record<string, RecipeHandler> = {
  lead_followup_sms: executeLeadFollowupSms,
  appointment_reminder_email: executeAppointmentReminderEmail,
  appointment_reminder_sms: executeAppointmentReminderSms,
  stale_customer_sms: executeStaleCustomerSms,
}

/**
 * Resolves the handler for an agent: a known recipe, or the free-form
 * outreach executor when the plan carries a freeform block. Returns null when
 * neither is present (plan saved but not runnable).
 */
function resolveScheduledHandler(agent: CustomAgentRow): RecipeHandler | null {
  const recipeId = agent.config.recipe?.id
  if (recipeId) return RECIPE_HANDLERS[recipeId] ?? null
  if (agent.config.freeform && FEATURES.freeformPlanner)
    return executeFreeformOutreach
  return null
}

/** Exported for the eval harness — recipes ship gated on tests (#6). */
export const EVENT_RECIPE_HANDLERS: Record<string, EventRecipeHandler> = {
  payment_received_thank_you_sms: executePaymentReceivedThankYouSms,
  booking_approved_prep_email: executeBookingApprovedPrepEmail,
  review_request_sms: executeReviewRequestSms,
  review_request_email: executeReviewRequestEmail,
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
  const triggerSource: TriggerSource = `event:${event.kind}`
  const recipeId = agent.config.recipe?.id
  if (!recipeId) {
    const outcome: AgentRunOutcome = {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "no recipe on this agent",
    }
    await recordAgentRun(supabase, {
      agentId: agent.id,
      shopId: shop.id,
      triggerSource,
      outcome,
    })
    return outcome
  }
  const handler = EVENT_RECIPE_HANDLERS[recipeId]
  if (!handler) {
    const outcome: AgentRunOutcome = {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: `unknown event recipe: ${recipeId}`,
    }
    await recordAgentRun(supabase, {
      agentId: agent.id,
      shopId: shop.id,
      triggerSource,
      outcome,
    })
    return outcome
  }
  if (shop.simulation_mode) {
    const outcome: AgentRunOutcome = {
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "shadow mode — nothing staged",
    }
    await recordAgentRun(supabase, {
      agentId: agent.id,
      shopId: shop.id,
      triggerSource,
      outcome,
    })
    return outcome
  }
  const outcome = await maybeAutoExecute(
    supabase,
    shop,
    agent,
    await handler(supabase, shop, agent, event)
  )
  await recordAgentRun(supabase, {
    agentId: agent.id,
    shopId: shop.id,
    triggerSource,
    outcome,
  })
  return outcome
}

/**
 * Autonomous post-step (BUILD_REFERENCE §5). For an agent in autonomous mode,
 * immediately execute the non-floor pending_actions the handler just staged —
 * so they send + log instead of waiting in /approvals. ALWAYS_HITL actions
 * (money / calendar) are never auto-executed; they stay pending for a human.
 *
 * executeApproval is dynamic-imported to avoid a static import cycle
 * (agent-runtime → approvals → agent-events → agent-runtime).
 *
 * Note: while this auto-executes, the handler may also have posted a Slack
 * approval card (when FEATURES.slackApprovals is on) — a known limitation until
 * staging is mode-aware. With Slack off (MVP default) there's no stale card.
 */
async function maybeAutoExecute(
  supabase: SupabaseClient,
  shop: ShopRow,
  agent: CustomAgentRow,
  outcome: AgentRunOutcome
): Promise<AgentRunOutcome> {
  if (!outcome.fired) return outcome
  const ids = outcome.pendingActionIds ?? []
  if (ids.length === 0) return outcome
  // Autonomy is a Package 2 capability; nothing auto-executes without it.
  if (!hasPackage2(shop)) return outcome
  const agentAuto = resolveAgentMode(shop, agent.id) === "autonomous"

  const { data } = await supabase
    .from("pending_actions")
    .select("id, action_type, status")
    .in("id", ids)
  const rows =
    (data as
      | { id: string; action_type: PendingActionType; status: string }[]
      | null) ?? []

  const { executeApproval } = await import("@/lib/approvals")
  let executed = 0
  for (const row of rows) {
    if (row.status !== "pending") continue
    if (!isAutonomyAllowed(row.action_type)) continue
    // Auto-execute when the whole agent is autonomous OR this action type has
    // earned its own graduation (L6). ALWAYS_HITL is already excluded above.
    const actionAuto =
      agentAuto || resolveAgentMode(shop, row.action_type) === "autonomous"
    if (!actionAuto) continue
    try {
      // context "automatic": if a calendar action ever slipped past the
      // ALWAYS_HITL filter above, the executor's conflict gate hard-blocks
      // it (D-015) — defense in depth, not the primary guard.
      const result = await executeApproval(
        supabase,
        row.id,
        { userId: agent.owner_id },
        { context: "automatic" }
      )
      if (result.ok && result.status === "executed") {
        executed += 1
        void recordApprovalResolution(supabase, row.id, "auto")
      }
    } catch (err) {
      console.error("[agent-runtime] autonomous execute threw:", err)
    }
  }

  return {
    ...outcome,
    stats: { ...(outcome.stats ?? {}), auto_executed: executed },
  }
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
  const triggerSource: TriggerSource = "manual"

  async function recordAndReturn(
    outcome: AgentRunOutcome
  ): Promise<AgentRunOutcome> {
    await recordAgentRun(supabase, {
      agentId: agent.id,
      shopId: agent.shop_id,
      triggerSource,
      outcome,
    })
    return outcome
  }

  const handler = resolveScheduledHandler(agent)
  if (!handler) {
    return recordAndReturn({
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "no runnable recipe or free-form plan on this agent",
    })
  }
  const shop = await loadShop(supabase, agent.shop_id)
  if (!shop) {
    return recordAndReturn({
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "shop not found",
    })
  }
  if (FEATURES.paywall && !isPaid(shop)) {
    return recordAndReturn({
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "requires a paid plan",
    })
  }
  if (FEATURES.paywall && (await isOverCreditLimit(supabase, shop))) {
    return recordAndReturn({
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason:
        "credit allowance used up — add a credit pack in Billing or wait for the next period",
    })
  }
  if (shop.simulation_mode) {
    return recordAndReturn({
      agentId: agent.id,
      agentName: agent.name,
      fired: false,
      reason: "shadow mode — nothing staged",
    })
  }
  const outcome = await maybeAutoExecute(
    supabase,
    shop,
    agent,
    await handler(supabase, shop, agent)
  )
  if (outcome.fired) {
    await stampFired(supabase, agent.id, agent.shop_id)
    await meterDrafts(supabase, agent.shop_id, agent.id, outcome)
  }
  return recordAndReturn(outcome)
}

/**
 * Locked menu (GRADIA_PRICING.md): 1 credit per outreach draft staged.
 * The run itself is plumbing — never metered; a fired run that staged
 * nothing costs nothing.
 */
async function meterDrafts(
  supabase: SupabaseClient,
  shopId: string,
  agentId: string,
  outcome: AgentRunOutcome
): Promise<void> {
  const drafts = outcome.pendingActionIds?.length ?? 0
  if (drafts <= 0) return
  const priced = priceUsage(await getPricing(supabase), "outreach_draft", drafts)
  await recordUsage(supabase, shopId, "outreach_draft", {
    quantity: drafts,
    credits: priced.credits,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
    refId: agentId,
  })
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
      const handler = resolveScheduledHandler(agent)
      if (!handler) {
        const outcome: AgentRunOutcome = {
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: "no runnable recipe or free-form plan",
        }
        outcomes.push(outcome)
        await recordAgentRun(supabase, {
          agentId: agent.id,
          shopId: agent.shop_id,
          triggerSource: "schedule",
          outcome,
        })
        continue
      }
      const decision = shouldFireOnSchedule(agent, now)
      if (!decision.fire) {
        const outcome: AgentRunOutcome = {
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: decision.reason,
        }
        outcomes.push(outcome)
        // recordAgentRun filters out the noisy "schedule not open" /
        // "fired recently" cases via shouldRecordOutcome — no-op for
        // those, persists meaningful skips like "no schedule on config".
        await recordAgentRun(supabase, {
          agentId: agent.id,
          shopId: agent.shop_id,
          triggerSource: "schedule",
          outcome,
        })
        continue
      }
      const shop = await getShop(agent.shop_id)
      if (!shop) {
        const outcome: AgentRunOutcome = {
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: "shop missing",
        }
        outcomes.push(outcome)
        await recordAgentRun(supabase, {
          agentId: agent.id,
          shopId: agent.shop_id,
          triggerSource: "schedule",
          outcome,
        })
        continue
      }
      // Scheduled (background) firing requires a paid plan — Core and
      // Package 2 both qualify; free/past_due get nothing (no free packages).
      // Whether a fired agent stages-only or auto-sends is decided downstream
      // by resolveAgentMode (autonomy = Package 2). This gate only governs
      // whether the scheduler runs the agent at all.
      if (FEATURES.paywall && !isPaid(shop)) {
        const outcome: AgentRunOutcome = {
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: "requires a paid plan",
        }
        outcomes.push(outcome)
        await recordAgentRun(supabase, {
          agentId: agent.id,
          shopId: agent.shop_id,
          triggerSource: "schedule",
          outcome,
        })
        continue
      }
      if (FEATURES.paywall && (await isOverCreditLimit(supabase, shop))) {
        const outcome: AgentRunOutcome = {
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: "credit limit reached",
        }
        outcomes.push(outcome)
        await recordAgentRun(supabase, {
          agentId: agent.id,
          shopId: agent.shop_id,
          triggerSource: "schedule",
          outcome,
        })
        continue
      }
      if (shop.simulation_mode) {
        const outcome: AgentRunOutcome = {
          agentId: agent.id,
          agentName: agent.name,
          fired: false,
          reason: "shadow mode — nothing staged",
        }
        outcomes.push(outcome)
        await recordAgentRun(supabase, {
          agentId: agent.id,
          shopId: agent.shop_id,
          triggerSource: "schedule",
          outcome,
        })
        continue
      }
      const outcome = await maybeAutoExecute(
        supabase,
        shop,
        agent,
        await handler(supabase, shop, agent)
      )
      if (outcome.fired) {
        await stampFired(supabase, agent.id, agent.shop_id)
        await meterDrafts(supabase, agent.shop_id, agent.id, outcome)
        fired += 1
      }
      outcomes.push(outcome)
      await recordAgentRun(supabase, {
        agentId: agent.id,
        shopId: agent.shop_id,
        triggerSource: "schedule",
        outcome,
      })
    } catch (err) {
      console.error("[agent-runtime] agent crashed:", agent.id, err)
      const outcome: AgentRunOutcome = {
        agentId: agent.id,
        agentName: agent.name,
        fired: false,
        reason: err instanceof Error ? err.message : String(err),
      }
      outcomes.push(outcome)
      await recordAgentRun(supabase, {
        agentId: agent.id,
        shopId: agent.shop_id,
        triggerSource: "schedule",
        outcome,
      })
    }
  }

  return { considered: agents.length, fired, outcomes }
}

