import { createClient } from "@/lib/supabase/server"
import { listScoredLeadsForCurrentShop, type ScoredLead } from "@/lib/data/leads"
import { FEATURES } from "@/lib/features"
import { noShowLadderState } from "@/lib/no-show-ladder"
import { requireShop } from "@/lib/shop"
import type { AppointmentRow, CustomerRow } from "@/lib/types/database"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A single proactive nudge surfaced on the dashboard co-owner card.
 * Each kind has a stable reason string so the operator understands
 * *why* we're suggesting this.
 */
export type CoOwnerSuggestion =
  | {
      kind: "setup"
      id: string
      title: string
      body: string
      href: string
      cta: string
    }
  | {
      kind: "hot_lead_followup"
      leadId: string
      customerId: string | null
      customerName: string
      phone: string | null
      reason: string
      heatLabel: string
    }
  | {
      kind: "stale_new_lead"
      leadId: string
      customerId: string | null
      customerName: string
      phone: string | null
      reason: string
      daysOld: number
    }
  | {
      kind: "upcoming_appointment"
      appointmentId: string
      customerName: string
      service: string | null
      whenIso: string
    }
  | {
      // No-show ladder (NEXT-2): imminent appointment, still unconfirmed —
      // at risk of a no-show. Owner can nudge to confirm or backfill the slot.
      kind: "unconfirmed_appointment"
      appointmentId: string
      customerName: string
      service: string | null
      whenIso: string
    }

/**
 * Top-N proactive suggestions for what the operator should tackle
 * next. Honest framing: these are heuristics over data we already
 * have (heat score + outbound interaction recency + lead age +
 * upcoming appointments), not an LLM-at-runtime call. Cheap to
 * compute on every dashboard load.
 */
export async function getCoOwnerSuggestions(limit = 4): Promise<
  CoOwnerSuggestion[]
> {
  const shop = await requireShop()
  const supabase = await createClient()

  const [scored, recentOutboundRes, upcomingRes, shopRowRes] = await Promise.all([
    listScoredLeadsForCurrentShop(),
    // Last outbound message per customer in the last 24h. Used to
    // skip "you should follow up" for customers we already pinged.
    supabase
      .from("interactions")
      .select("customer_id, occurred_at")
      .eq("shop_id", shop.id)
      .eq("role", "gradia")
      .gte("occurred_at", new Date(Date.now() - DAY_MS).toISOString()),
    supabase
      .from("appointments")
      .select("*, customer:customers(name)")
      .eq("shop_id", shop.id)
      .gte("scheduled_at", new Date().toISOString())
      .lte("scheduled_at", new Date(Date.now() + DAY_MS).toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(3),
    supabase
      .from("shops")
      .select(
        "aurinko_account_email, twilio_phone_number, voice_addon, voice_live, settings"
      )
      .eq("id", shop.id)
      .maybeSingle(),
  ])

  const recentlyContacted = new Set<string>()
  for (const row of (recentOutboundRes.data as
    | { customer_id: string | null; occurred_at: string }[]
    | null) ?? []) {
    if (row.customer_id) recentlyContacted.add(row.customer_id)
  }

  const suggestions: CoOwnerSuggestion[] = []
  const now = Date.now()

  // 0. Setup the owner skipped in the wizard — surfaced here per the UX
  //    spec ("do later" moves it to a Today-page nudge). One at a time:
  //    the next missing wire, not a checklist wall.
  const shopRow = (shopRowRes.data as {
    aurinko_account_email: string | null
    twilio_phone_number: string | null
    voice_addon: boolean
    voice_live: boolean
    settings?: Record<string, unknown>
  } | null) ?? null
  if (shopRow && shopRow.settings?.onboarding_done !== false) {
    if (!shopRow.aurinko_account_email) {
      suggestions.push({
        kind: "setup",
        id: "setup-email",
        title: "Connect Gmail",
        body: "Thirty seconds, one button — then inbound emails come with a drafted reply waiting on your yes.",
        href: "/settings#email",
        cta: "Connect",
      })
    } else if (!shopRow.twilio_phone_number) {
      suggestions.push({
        kind: "setup",
        id: "setup-number",
        title: "Get your business number",
        body: "A line customers call and text. Calls work the moment you pick it.",
        href: "/settings#sms",
        cta: "Pick a number",
      })
    } else if (shopRow.voice_addon && !shopRow.voice_live) {
      suggestions.push({
        kind: "setup",
        id: "setup-voice",
        title: "Finish your receptionist",
        body: "It's part of your plan — do the test call and flip it live.",
        href: "/settings#voice",
        cta: "Finish setup",
      })
    }
  }

  // 1. Hottest leads we haven't pinged today.
  const hot = scored
    .filter((l): l is ScoredLead => Boolean(l.heat))
    .filter((l) => l.heat.label === "hot")
    .filter((l) => l.status !== "booked")
    .filter((l) => !l.customer_id || !recentlyContacted.has(l.customer_id))
    .slice(0, 2)

  for (const lead of hot) {
    suggestions.push({
      kind: "hot_lead_followup",
      leadId: lead.id,
      customerId: lead.customer_id,
      customerName: lead.customer_name,
      phone: lead.phone || null,
      reason: hotReason(lead),
      heatLabel: lead.heat.label,
    })
  }

  // 2. Stale "new" leads more than 3 days old.
  for (const lead of scored) {
    if (suggestions.length >= limit) break
    if (lead.status !== "new") continue
    const ageDays = (now - new Date(lead.created_at).getTime()) / DAY_MS
    if (ageDays < 3) continue
    if (lead.customer_id && recentlyContacted.has(lead.customer_id)) continue
    // Skip duplicates from the hot-lead pass.
    if (suggestions.some(
      (s) => s.kind === "hot_lead_followup" && s.leadId === lead.id
    )) continue
    suggestions.push({
      kind: "stale_new_lead",
      leadId: lead.id,
      customerId: lead.customer_id,
      customerName: lead.customer_name,
      phone: lead.phone || null,
      reason: `${Math.floor(ageDays)} days old and still untouched.`,
      daysOld: Math.floor(ageDays),
    })
  }

  type JoinedAppt = AppointmentRow & {
    customer: Pick<CustomerRow, "name"> | null
  }
  const upcomingAppts = (upcomingRes.data as JoinedAppt[] | null) ?? []
  const atRisk = new Set<string>()

  // 2.5. At-risk appointments — imminent + still unconfirmed (no-show ladder).
  //      Actionable, so they lead the passive upcoming nudges.
  if (FEATURES.noShowLadder) {
    for (const appt of upcomingAppts) {
      if (suggestions.length >= limit) break
      if (noShowLadderState(appt, now) !== "awaiting_confirm") continue
      atRisk.add(appt.id)
      suggestions.push({
        kind: "unconfirmed_appointment",
        appointmentId: appt.id,
        customerName: appt.customer?.name?.trim() || "a customer",
        service: appt.service_name ?? null,
        whenIso: appt.scheduled_at,
      })
    }
  }

  // 3. Upcoming appointments in the next 24h (passive nudge) — skip the at-risk
  //    ones already surfaced above.
  for (const appt of upcomingAppts) {
    if (suggestions.length >= limit) break
    if (atRisk.has(appt.id)) continue
    suggestions.push({
      kind: "upcoming_appointment",
      appointmentId: appt.id,
      customerName: appt.customer?.name?.trim() || "a customer",
      service: appt.service_name ?? null,
      whenIso: appt.scheduled_at,
    })
  }

  return suggestions.slice(0, limit)
}

function hotReason(lead: ScoredLead): string {
  // Pick the dominant signal from the heat breakdown for a
  // human-readable nudge.
  const b = lead.heat.breakdown
  const top = Object.entries(b).reduce<{ key: string; value: number }>(
    (acc, [k, v]) => (v > acc.value ? { key: k, value: v } : acc),
    { key: "", value: -Infinity }
  )
  switch (top.key) {
    case "inbound_response":
      return "They replied recently — strike while it's warm."
    case "recent_activity":
      return "Lots of recent activity on this thread."
    case "repeat_customer":
      return "Repeat customer — they already trust us."
    case "status":
      return "Already quoted — closer to a yes."
    default:
      return "Heat score is high — worth a tap."
  }
}
