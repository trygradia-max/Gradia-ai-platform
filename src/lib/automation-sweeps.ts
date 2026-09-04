/**
 * Automation sweeps (CRM C5) — deterministic candidate finders for the
 * catalog, run by the automations cron. SQL/code picks candidates; templates
 * fill from data; the runner (automations.ts) stages or sends through the
 * one send path. Each sweep is idempotent via automation_runs trigger_ref.
 *
 * #5/#6 (confirm/reminder) are NOT here — their existing crons keep their
 * exact machinery and consult the catalog for enabled/mode (zero behavior
 * change by default).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  AUTOMATION_CATALOG,
  loadAutomationConfigs,
  renderTemplate,
  runAutomationForTarget,
  type AutomationCatalogKey,
  type AutomationConfig,
} from "@/lib/automations"
import { advanceQuoteFollowUps } from "@/lib/pipeline"
import { quotePath } from "@/lib/quotes"
import { getReviewLink } from "@/lib/review-link"
import type { QuoteRow, ShopRow } from "@/lib/types/database"

type SweepShop = Pick<
  ShopRow,
  | "id"
  | "owner_id"
  | "name"
  | "plan"
  | "tier"
  | "voice_addon"
  | "trial_ends_at"
  | "credit_period_start"
  | "settings"
>

export type SweepStats = Record<string, { considered: number; acted: number }>

const NEW_LEAD_WAIT_MINUTES = 5
const NEW_LEAD_MAX_AGE_HOURS = 48
const MISSED_CALL_MAX_AGE_HOURS = 6
const MISSED_CALL_SHORT_SECONDS = 10
const REVIVAL_SILENT_DAYS = 21
export const QUOTE_FOLLOWUP_DAYS = [2, 5, 12] as const
const REVIEW_DELAY_HOURS_DEFAULT = 4
const COMPLETED_LOOKBACK_DAYS = 7

const QUOTE_FOLLOWUP_COPY: readonly string[] = [
  "Hi {customer_name}, just making sure you saw the quote we sent: {quote_link}. Any questions, we're right here. — {shop_name}",
  "Hi {customer_name}, {shop_name} here — still happy to get the car booked in whenever you're ready: {quote_link}. — {shop_name}",
  "Hi {customer_name}, last nudge from {shop_name}, promise! The quote's here if you'd like it: {quote_link}. Either way, thanks for considering us. — {shop_name}",
]

/** True when a call record reads as "we didn't really take that call". */
export function looksLikeMissedCall(record: {
  ended_reason: string | null
  duration_seconds: number | null
}): boolean {
  const reason = (record.ended_reason ?? "").toLowerCase()
  if (/no-?answer|did-?not-?answer|busy|failed|error|twilio-failed/.test(reason)) {
    return true
  }
  return (record.duration_seconds ?? Number.POSITIVE_INFINITY) < MISSED_CALL_SHORT_SECONDS
}

function publicOrigin(): string {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      /* fall through */
    }
  }
  return ""
}

/** Run every catalog sweep for one shop. Returns per-key stats. */
export async function runAutomationSweeps(
  supabase: SupabaseClient,
  shop: SweepShop,
  now: Date = new Date()
): Promise<SweepStats> {
  const configs = await loadAutomationConfigs(supabase, shop.id)
  const stats: SweepStats = {}
  const track = (key: AutomationCatalogKey, considered: number, acted: number) => {
    stats[key] = { considered, acted }
  }

  const run = async (
    key: AutomationCatalogKey,
    fn: (config: AutomationConfig) => Promise<[number, number]>
  ) => {
    const config = configs.get(key)
    if (!config?.enabled) {
      track(key, 0, 0)
      return
    }
    try {
      const [considered, acted] = await fn(config)
      track(key, considered, acted)
    } catch (err) {
      console.error(`[automation-sweeps] ${key} failed for ${shop.id}:`, err)
      track(key, 0, 0)
    }
  }

  await run("new_lead_instant", (c) => sweepNewLeadInstant(supabase, shop, c, now))
  await run("missed_call_textback", (c) => sweepMissedCallTextback(supabase, shop, c, now))
  await run("quote_followup", (c) => sweepQuoteFollowup(supabase, shop, c, now))
  await run("lead_revival", (c) => sweepLeadRevival(supabase, shop, c, now))
  await run("job_completed", (c) => sweepJobCompleted(supabase, shop, c, now))
  await run("review_request", (c) => sweepReviewRequest(supabase, shop, c, now))
  return stats
}

/** #1 — lead created ≥5 min ago, nothing outbound since. Speed is the point. */
async function sweepNewLeadInstant(
  supabase: SupabaseClient,
  shop: SweepShop,
  config: AutomationConfig,
  now: Date
): Promise<[number, number]> {
  const newest = new Date(now.getTime() - NEW_LEAD_WAIT_MINUTES * 60_000).toISOString()
  const oldest = new Date(now.getTime() - NEW_LEAD_MAX_AGE_HOURS * 3_600_000).toISOString()
  const { data } = await supabase
    .from("leads")
    .select("id, customer_id, customer_name, phone, created_at, status")
    .eq("shop_id", shop.id)
    .eq("status", "new")
    .gte("created_at", oldest)
    .lte("created_at", newest)
    .limit(50)
  const leads =
    (data as { id: string; customer_id: string | null; customer_name: string; phone: string; created_at: string }[] | null) ??
    []

  let acted = 0
  for (const lead of leads) {
    if (!lead.phone?.trim()) continue
    // "No contact": no outbound interaction to this customer since the lead
    // landed. Leads without a customer link check nothing — better to text
    // once than to go silent (dedupe still guarantees once).
    if (lead.customer_id) {
      const { count } = await supabase
        .from("interactions")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", shop.id)
        .eq("customer_id", lead.customer_id)
        .eq("role", "gradia")
        .gte("occurred_at", lead.created_at)
      if ((count ?? 0) > 0) continue
    }
    const body = renderTemplate(config.template, {
      customer_name: firstName(lead.customer_name),
      shop_name: shop.name,
    })
    const outcome = await runAutomationForTarget(supabase, shop, config, {
      customerId: lead.customer_id,
      leadId: lead.id,
      toPhone: lead.phone,
      customerName: lead.customer_name,
      body,
      triggerRef: `lead:${lead.id}`,
      reason: "New lead — instant reply",
      category: "transactional",
    })
    if (outcome.ok && outcome.status !== "skipped_duplicate") acted += 1
  }
  return [leads.length, acted]
}

/** #2 — recent call we didn't take, no text since. */
async function sweepMissedCallTextback(
  supabase: SupabaseClient,
  shop: SweepShop,
  config: AutomationConfig,
  now: Date
): Promise<[number, number]> {
  const oldest = new Date(now.getTime() - MISSED_CALL_MAX_AGE_HOURS * 3_600_000).toISOString()
  const { data } = await supabase
    .from("call_records")
    .select("id, customer_id, ended_reason, duration_seconds, started_at")
    .eq("shop_id", shop.id)
    .gte("started_at", oldest)
    .limit(50)
  const records =
    (data as {
      id: string
      customer_id: string | null
      ended_reason: string | null
      duration_seconds: number | null
      started_at: string | null
    }[] | null) ?? []

  let acted = 0
  const missed = records.filter(looksLikeMissedCall)
  for (const rec of missed) {
    if (!rec.customer_id) continue
    const { data: cust } = await supabase
      .from("customers")
      .select("id, name, phone")
      .eq("id", rec.customer_id)
      .maybeSingle()
    const customer = cust as { id: string; name: string | null; phone: string | null } | null
    if (!customer?.phone) continue
    // Skip when we've texted them since the call.
    const { count } = await supabase
      .from("interactions")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shop.id)
      .eq("customer_id", customer.id)
      .eq("role", "gradia")
      .eq("channel", "sms")
      .gte("occurred_at", rec.started_at ?? oldest)
    if ((count ?? 0) > 0) continue

    const body = renderTemplate(config.template, {
      customer_name: firstName(customer.name),
      shop_name: shop.name,
    })
    const outcome = await runAutomationForTarget(supabase, shop, config, {
      customerId: customer.id,
      toPhone: customer.phone,
      customerName: customer.name,
      body,
      triggerRef: `call:${rec.id}`,
      reason: "Missed call — text back",
      category: "transactional",
    })
    if (outcome.ok && outcome.status !== "skipped_duplicate") acted += 1
  }
  return [missed.length, acted]
}

/** #3 — 2d/5d/12d after a quote went quiet, escalating copy. Also drives
 *  the pipeline stage move through the existing exported sweep. */
async function sweepQuoteFollowup(
  supabase: SupabaseClient,
  shop: SweepShop,
  config: AutomationConfig,
  now: Date
): Promise<[number, number]> {
  // Stage move first (quote_sent past its timer → follow_up).
  await advanceQuoteFollowUps(supabase, { shopId: shop.id, now })

  const { data } = await supabase
    .from("quotes")
    .select("*, customers(id, name, phone)")
    .eq("shop_id", shop.id)
    .in("status", ["sent", "viewed"])
    .not("sent_at", "is", null)
    .limit(100)
  const quotes =
    (data as (QuoteRow & { customers: { id: string; name: string | null; phone: string | null } | null })[] | null) ??
    []

  const origin = publicOrigin()
  let acted = 0
  for (const quote of quotes) {
    if (!quote.customers?.phone || !quote.sent_at) continue
    const daysSilent = (now.getTime() - Date.parse(quote.sent_at)) / 86_400_000
    // Highest due touch wins; trigger_ref per touch keeps it 3-max forever.
    let touch = -1
    for (let i = QUOTE_FOLLOWUP_DAYS.length - 1; i >= 0; i--) {
      if (daysSilent >= QUOTE_FOLLOWUP_DAYS[i]) {
        touch = i
        break
      }
    }
    if (touch < 0) continue

    const template =
      config.template !== catalogDefault("quote_followup")
        ? config.template // owner override applies to every touch
        : QUOTE_FOLLOWUP_COPY[touch]
    const body = renderTemplate(template, {
      customer_name: firstName(quote.customers.name),
      shop_name: shop.name,
      quote_link: quote.public_token ? `${origin}${quotePath(quote.public_token)}` : "",
    })
    const outcome = await runAutomationForTarget(supabase, shop, config, {
      customerId: quote.customers.id,
      leadId: quote.lead_id,
      toPhone: quote.customers.phone,
      customerName: quote.customers.name,
      body,
      triggerRef: `quote:${quote.id}:touch${touch + 1}`,
      reason: `Quote follow-up ${touch + 1} of 3`,
      category: "marketing",
    })
    if (outcome.ok && outcome.status !== "skipped_duplicate") acted += 1
  }
  return [quotes.length, acted]
}

/** #4 — engaged leads silent for 21 days. */
async function sweepLeadRevival(
  supabase: SupabaseClient,
  shop: SweepShop,
  config: AutomationConfig,
  now: Date
): Promise<[number, number]> {
  const cutoff = new Date(now.getTime() - REVIVAL_SILENT_DAYS * 86_400_000).toISOString()
  const { data } = await supabase
    .from("leads")
    .select("id, customer_id, customer_name, phone, created_at")
    .eq("shop_id", shop.id)
    .in("status", ["new", "quoted"])
    .lt("created_at", cutoff)
    .limit(50)
  const leads =
    (data as { id: string; customer_id: string | null; customer_name: string; phone: string }[] | null) ?? []

  let acted = 0
  for (const lead of leads) {
    if (!lead.phone?.trim() || !lead.customer_id) continue
    // "Had engaged": at least one inbound message ever.
    const { count: inbound } = await supabase
      .from("interactions")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shop.id)
      .eq("customer_id", lead.customer_id)
      .eq("role", "customer")
    if ((inbound ?? 0) === 0) continue
    // "Silent 21d": nothing either direction in the window.
    const { count: recent } = await supabase
      .from("interactions")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shop.id)
      .eq("customer_id", lead.customer_id)
      .gte("occurred_at", cutoff)
    if ((recent ?? 0) > 0) continue

    const body = renderTemplate(config.template, {
      customer_name: firstName(lead.customer_name),
      shop_name: shop.name,
    })
    const outcome = await runAutomationForTarget(supabase, shop, config, {
      customerId: lead.customer_id,
      leadId: lead.id,
      toPhone: lead.phone,
      customerName: lead.customer_name,
      body,
      triggerRef: `revival:${lead.id}`,
      reason: "Lead revival — 3 weeks quiet",
      category: "marketing",
    })
    if (outcome.ok && outcome.status !== "skipped_duplicate") acted += 1
  }
  return [leads.length, acted]
}

/** Completed-job events from the timeline (written by advanceJobStatus). */
async function completedEvents(
  supabase: SupabaseClient,
  shopId: string,
  sinceIso: string
): Promise<{ appointmentId: string; customerId: string | null; occurredAt: string }[]> {
  const { data } = await supabase
    .from("interactions")
    .select("customer_id, occurred_at, metadata")
    .eq("shop_id", shopId)
    .eq("metadata->>kind", "job_status")
    .eq("metadata->>to", "completed")
    .gte("occurred_at", sinceIso)
    .limit(100)
  return (
    (data as { customer_id: string | null; occurred_at: string; metadata: Record<string, unknown> }[] | null) ?? []
  )
    .map((r) => ({
      appointmentId: String(r.metadata?.appointment_id ?? ""),
      customerId: r.customer_id,
      occurredAt: r.occurred_at,
    }))
    .filter((r) => r.appointmentId)
}

/** #7 — thanks + aftercare right after Complete. */
async function sweepJobCompleted(
  supabase: SupabaseClient,
  shop: SweepShop,
  config: AutomationConfig,
  now: Date
): Promise<[number, number]> {
  const since = new Date(now.getTime() - COMPLETED_LOOKBACK_DAYS * 86_400_000).toISOString()
  const events = await completedEvents(supabase, shop.id, since)
  let acted = 0
  for (const evt of events) {
    if (!evt.customerId) continue
    const target = await completedTarget(supabase, shop, evt)
    if (!target) continue
    const body = renderTemplate(config.template, target.vars)
    const outcome = await runAutomationForTarget(supabase, shop, config, {
      customerId: evt.customerId,
      toPhone: target.phone,
      customerName: target.name,
      body,
      triggerRef: `completed:${evt.appointmentId}`,
      reason: "Job completed — thanks + care",
      category: "transactional",
    })
    if (outcome.ok && outcome.status !== "skipped_duplicate") acted += 1
  }
  return [events.length, acted]
}

/** #8 — the neutral review ask, delay-tunable, needs a review link. */
async function sweepReviewRequest(
  supabase: SupabaseClient,
  shop: SweepShop,
  config: AutomationConfig,
  now: Date
): Promise<[number, number]> {
  const reviewLink = getReviewLink({ settings: shop.settings })
  if (!reviewLink) return [0, 0] // nothing to link to — skip entirely

  const delayHours =
    typeof config.config.delay_hours === "number" && config.config.delay_hours > 0
      ? config.config.delay_hours
      : REVIEW_DELAY_HOURS_DEFAULT
  const since = new Date(now.getTime() - COMPLETED_LOOKBACK_DAYS * 86_400_000).toISOString()
  const dueBefore = now.getTime() - delayHours * 3_600_000

  const events = (await completedEvents(supabase, shop.id, since)).filter(
    (e) => Date.parse(e.occurredAt) <= dueBefore
  )
  let acted = 0
  for (const evt of events) {
    if (!evt.customerId) continue
    const target = await completedTarget(supabase, shop, evt)
    if (!target) continue
    const body = renderTemplate(config.template, { ...target.vars, review_link: reviewLink })
    const outcome = await runAutomationForTarget(supabase, shop, config, {
      customerId: evt.customerId,
      toPhone: target.phone,
      customerName: target.name,
      body,
      triggerRef: `review:${evt.appointmentId}`,
      reason: "Review request",
      category: "marketing",
    })
    if (outcome.ok && outcome.status !== "skipped_duplicate") acted += 1
  }
  return [events.length, acted]
}

async function completedTarget(
  supabase: SupabaseClient,
  shop: SweepShop,
  evt: { appointmentId: string; customerId: string | null }
): Promise<{ phone: string; name: string | null; vars: Record<string, string> } | null> {
  if (!evt.customerId) return null
  const { data: cust } = await supabase
    .from("customers")
    .select("name, phone")
    .eq("id", evt.customerId)
    .maybeSingle()
  const customer = cust as { name: string | null; phone: string | null } | null
  if (!customer?.phone) return null

  const { data: appt } = await supabase
    .from("appointments")
    .select("service_name")
    .eq("id", evt.appointmentId)
    .maybeSingle()
  const services =
    (appt as { service_name: string | null } | null)?.service_name ?? "detail"

  return {
    phone: customer.phone,
    name: customer.name,
    vars: {
      customer_name: firstName(customer.name),
      shop_name: shop.name,
      services,
    },
  }
}

function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there"
}

const AUTOMATION_CATALOG_DEFAULTS = new Map(
  AUTOMATION_CATALOG.map((e) => [e.key, e.defaultTemplate])
)

function catalogDefault(key: AutomationCatalogKey): string {
  return AUTOMATION_CATALOG_DEFAULTS.get(key) ?? ""
}
