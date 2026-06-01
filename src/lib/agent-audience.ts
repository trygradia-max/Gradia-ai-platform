/**
 * Free-form audience resolver — the safe half of the hybrid Chat agent.
 *
 * A FreeformPlan describes WHO to reach with WHITELISTED structured filters,
 * never raw SQL. This module maps those filters to constrained Supabase
 * queries and applies the mandatory guardrails before anyone is drafted:
 *   - contact requirement (phone for sms, email for email)
 *   - inactivity / no-recent-inbound windows
 *   - cooldown (don't re-contact within N days)
 *   - opt-out (skip anyone who texted STOP / unsubscribe)
 *   - a hard recipient cap
 *
 * Both the live executor and the dry-run preview call resolveFreeformAudience,
 * so the preview the operator approves is exactly what would be staged.
 *
 * Guardrail note: cooldown + opt-out are keyed on customer_id. Leads without a
 * linked customer record can't be matched here; for those, Twilio's
 * carrier-level STOP handling remains the backstop at send time.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { draftCustomEmailForCustomer } from "@/lib/email-drafter"
import { draftCustomSmsForCustomer } from "@/lib/sms-drafter"
import type {
  CustomerRow,
  FreeformChannel,
  FreeformPlan,
  LeadRow,
  ShopRow,
} from "@/lib/types/database"

const DAY_MS = 24 * 60 * 60 * 1000
const OVERFETCH = 4
const MAX_CANDIDATES = 500

export type AudienceTarget = {
  customerId: string | null
  leadId: string | null
  name: string | null
  phone: string | null
  email: string | null
  vehicle: string | null
  service: string | null
}

export type AudienceStats = {
  candidates: number
  skipped_no_contact: number
  skipped_active: number
  skipped_recent_inbound: number
  skipped_cooldown: number
  skipped_opted_out: number
}

export type AudienceResult = {
  targets: AudienceTarget[]
  stats: AudienceStats
  /** Set when the plan's entity/channel combo isn't runnable. */
  blocked?: string
}

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString()
}

function looksOptedOut(content: string): boolean {
  return /\b(stop|stopall|unsubscribe|cancel|opt\s?out|remove\s?me|quit)\b/i.test(
    content
  )
}

/** Strip characters that would break a PostgREST ilike / or() filter. */
function safeKeyword(kw: string): string {
  return kw.replace(/[%,()]/g, "").trim()
}

function customerIdsOf(targets: AudienceTarget[]): string[] {
  return targets
    .map((t) => t.customerId)
    .filter((id): id is string => Boolean(id))
}

/**
 * Resolves a FreeformPlan to the final, guardrail-filtered list of recipients
 * (capped at plan.max_recipients). Pure read — never writes or sends.
 */
export async function resolveFreeformAudience(
  supabase: SupabaseClient,
  shop: ShopRow,
  plan: FreeformPlan
): Promise<AudienceResult> {
  const stats: AudienceStats = {
    candidates: 0,
    skipped_no_contact: 0,
    skipped_active: 0,
    skipped_recent_inbound: 0,
    skipped_cooldown: 0,
    skipped_opted_out: 0,
  }
  const cap = Math.min(Math.max(plan.max_recipients || 50, 1), 200)
  const f = plan.filters ?? {}
  const fetchLimit = Math.min(cap * OVERFETCH, MAX_CANDIDATES)

  // Leads carry a phone, not an email — email outreach must target customers.
  if (plan.channel === "email" && plan.entity === "leads") {
    return {
      targets: [],
      stats,
      blocked: "Email outreach needs customers — leads have no email on file.",
    }
  }

  let targets: AudienceTarget[] = []

  if (plan.entity === "leads") {
    let q = supabase.from("leads").select("*").eq("shop_id", shop.id)
    if (f.lead_status) q = q.eq("status", f.lead_status)
    if (f.min_age_days != null) q = q.lte("created_at", iso(f.min_age_days))
    if (f.max_age_days != null) q = q.gte("created_at", iso(f.max_age_days))
    if (f.keyword) {
      const kw = safeKeyword(f.keyword)
      if (kw)
        q = q.or(
          `car_info.ilike.%${kw}%,pin_notes.ilike.%${kw}%,customer_name.ilike.%${kw}%`
        )
    }
    q = q.order("created_at", { ascending: false }).limit(fetchLimit)
    const { data, error } = await q
    if (error) throw new Error(`audience (leads) query failed: ${error.message}`)
    targets = ((data as LeadRow[] | null) ?? []).map((l) => ({
      customerId: l.customer_id,
      leadId: l.id,
      name: l.customer_name,
      phone: l.phone,
      email: null,
      vehicle: l.car_info,
      service: l.pin_notes,
    }))
  } else {
    let q = supabase
      .from("customers")
      .select("id, name, phone, email")
      .eq("shop_id", shop.id)
    if (f.keyword) {
      const kw = safeKeyword(f.keyword)
      if (kw) q = q.ilike("name", `%${kw}%`)
    }
    q = q.order("updated_at", { ascending: false }).limit(fetchLimit)
    const { data, error } = await q
    if (error)
      throw new Error(`audience (customers) query failed: ${error.message}`)
    targets = (
      (data as Pick<CustomerRow, "id" | "name" | "phone" | "email">[] | null) ??
      []
    ).map((c) => ({
      customerId: c.id,
      leadId: null,
      name: c.name,
      phone: c.phone,
      email: c.email,
      vehicle: null,
      service: null,
    }))
  }

  stats.candidates = targets.length

  // Contact requirement for the channel.
  targets = targets.filter((t) => {
    const ok =
      plan.channel === "sms" ? Boolean(t.phone?.trim()) : Boolean(t.email?.trim())
    if (!ok) stats.skipped_no_contact += 1
    return ok
  })

  // inactive_days (customers only): exclude anyone active inside the window.
  if (plan.entity === "customers" && f.inactive_days != null) {
    const ids = customerIdsOf(targets)
    if (ids.length) {
      const { data } = await supabase
        .from("interactions")
        .select("customer_id")
        .eq("shop_id", shop.id)
        .in("customer_id", ids)
        .gt("occurred_at", iso(f.inactive_days))
      const active = new Set(
        ((data as { customer_id: string | null }[] | null) ?? [])
          .map((r) => r.customer_id)
          .filter((x): x is string => Boolean(x))
      )
      targets = targets.filter((t) => {
        const hit = t.customerId != null && active.has(t.customerId)
        if (hit) stats.skipped_active += 1
        return !hit
      })
    }
  }

  // no_inbound_within_days: skip targets who reached out to us recently.
  if (f.no_inbound_within_days != null) {
    const ids = customerIdsOf(targets)
    if (ids.length) {
      const { data } = await supabase
        .from("interactions")
        .select("customer_id")
        .eq("shop_id", shop.id)
        .eq("role", "customer")
        .in("customer_id", ids)
        .gt("occurred_at", iso(f.no_inbound_within_days))
      const recent = new Set(
        ((data as { customer_id: string | null }[] | null) ?? [])
          .map((r) => r.customer_id)
          .filter((x): x is string => Boolean(x))
      )
      targets = targets.filter((t) => {
        const hit = t.customerId != null && recent.has(t.customerId)
        if (hit) stats.skipped_recent_inbound += 1
        return !hit
      })
    }
  }

  // Cooldown: skip anyone we already messaged on this channel recently.
  {
    const ids = customerIdsOf(targets)
    if (ids.length) {
      const { data } = await supabase
        .from("interactions")
        .select("customer_id")
        .eq("shop_id", shop.id)
        .eq("role", "gradia")
        .eq("channel", plan.channel)
        .in("customer_id", ids)
        .gt("occurred_at", iso(plan.cooldown_days))
      const cooled = new Set(
        ((data as { customer_id: string | null }[] | null) ?? [])
          .map((r) => r.customer_id)
          .filter((x): x is string => Boolean(x))
      )
      targets = targets.filter((t) => {
        const hit = t.customerId != null && cooled.has(t.customerId)
        if (hit) stats.skipped_cooldown += 1
        return !hit
      })
    }
  }

  // Opt-out: skip anyone who ever texted STOP / unsubscribe.
  {
    const ids = customerIdsOf(targets)
    if (ids.length) {
      const { data } = await supabase
        .from("interactions")
        .select("customer_id, content")
        .eq("shop_id", shop.id)
        .eq("role", "customer")
        .in("customer_id", ids)
      const optedOut = new Set<string>()
      for (const r of (data as
        | { customer_id: string | null; content: string }[]
        | null) ?? []) {
        if (r.customer_id && looksOptedOut(r.content)) optedOut.add(r.customer_id)
      }
      targets = targets.filter((t) => {
        const hit = t.customerId != null && optedOut.has(t.customerId)
        if (hit) stats.skipped_opted_out += 1
        return !hit
      })
    }
  }

  return { targets: targets.slice(0, cap), stats }
}

export type FreeformPreviewSample = {
  name: string | null
  to: string
  channel: FreeformChannel
  subject?: string
  message: string
}

export type FreeformPreview = {
  /** Total recipients that match right now (post-guardrails). */
  count: number
  stats: AudienceStats
  samples: FreeformPreviewSample[]
  /** Set when the plan isn't runnable (e.g. email on leads). */
  blocked?: string
}

/**
 * Dry-run: resolve the audience and draft a few real sample messages WITHOUT
 * staging anything. Powers the builder's "Preview audience" step so the
 * operator sees exactly who this reaches and how it reads before enabling.
 */
export async function previewFreeformPlan(
  supabase: SupabaseClient,
  shop: ShopRow,
  plan: FreeformPlan,
  sampleCount = 3
): Promise<FreeformPreview> {
  const audience = await resolveFreeformAudience(supabase, shop, plan)
  if (audience.blocked) {
    return {
      count: 0,
      stats: audience.stats,
      samples: [],
      blocked: audience.blocked,
    }
  }

  const samples: FreeformPreviewSample[] = []
  for (const t of audience.targets.slice(0, sampleCount)) {
    if (plan.channel === "sms") {
      if (!t.phone) continue
      const body = await draftCustomSmsForCustomer({
        shopName: shop.name,
        customerName: t.name ?? "there",
        vehicle: t.vehicle,
        service: t.service,
        intent: plan.message_intent,
      }).catch(() => null)
      if (body)
        samples.push({ name: t.name, to: t.phone, channel: "sms", message: body })
    } else {
      if (!t.email) continue
      const draft = await draftCustomEmailForCustomer({
        shopName: shop.name,
        customerName: t.name ?? "there",
        service: t.service,
        when: null,
        intent: plan.message_intent,
      }).catch(() => null)
      if (draft)
        samples.push({
          name: t.name,
          to: t.email,
          channel: "email",
          subject: draft.subject,
          message: draft.body,
        })
    }
  }

  return { count: audience.targets.length, stats: audience.stats, samples }
}
