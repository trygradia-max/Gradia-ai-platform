/**
 * Whisper suggestion queue (CRM C6a) — "What I'd tackle next", grounded.
 *
 * Locked shape (spec §C6 + run rail): the CANDIDATE PICKING is pure code
 * over DB rows (this module — golden-fixture tested), the WHY is composed
 * deterministically from those same facts (so a suggestion can only ever
 * cite DB-queryable facts), and the model's only job is the draft copy —
 * a single-turn worker, metered with credit pre-check, fail closed. No
 * agent loops. Approval flows through pending_actions like every outbound.
 */

import type { CrmStage, QuoteStatus } from "@/lib/types/database"
import { formatPriceUsd } from "@/lib/service-pricing"

export const SUGGESTION_KINDS = [
  "stale_quote",
  "follow_up_due",
  "lead_revival",
] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

/** Days a sent/viewed quote may sit silent before it's "stale". */
export const STALE_QUOTE_DAYS = 5
/** Engaged-then-silent window for revival (matches automation #4). */
export const REVIVAL_SILENT_DAYS = 21
/** Max suggestions generated per shop per sweep (credit discipline). */
export const MAX_SUGGESTIONS_PER_SWEEP = 3

const DAY_MS = 86_400_000

export type SuggestionCandidate = {
  kind: SuggestionKind
  /** Idempotency ref — one suggestion per ref, ever. */
  ref: string
  customerId: string | null
  leadId: string | null
  phone: string
  customerName: string | null
  /** Deterministic, DB-fact-only rationale shown on the card. */
  why: string
  /** What the draft worker is asked to write (plain-English intent). */
  draftIntent: string
}

// ---------- input row shapes (plain data — fixture-friendly) ----------

export type QuoteForSuggestion = {
  id: string
  status: QuoteStatus
  sent_at: string | null
  viewed_at: string | null
  responded_at: string | null
  total_cents: number
  customer_id: string
  lead_id: string | null
  customer_name: string | null
  customer_phone: string | null
}

export type LeadForSuggestion = {
  id: string
  customer_id: string | null
  customer_name: string
  phone: string
  stage: CrmStage | null
  next_action_at: string | null
  created_at: string
  /** Latest inbound (customer) interaction, if any. */
  last_inbound_at: string | null
  /** Latest interaction either direction, if any. */
  last_activity_at: string | null
}

function daysAgo(iso: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(iso)) / DAY_MS)
}

// ---------- pickers (pure — golden-fixture tested) ----------

/** Sent/viewed quotes ≥5 days silent. */
export function pickStaleQuotes(
  quotes: QuoteForSuggestion[],
  now: Date
): SuggestionCandidate[] {
  const nowMs = now.getTime()
  const out: SuggestionCandidate[] = []
  for (const q of quotes) {
    if (q.status !== "sent" && q.status !== "viewed") continue
    if (!q.sent_at || q.responded_at) continue
    if (!q.customer_phone) continue
    const silentDays = daysAgo(q.sent_at, nowMs)
    if (silentDays < STALE_QUOTE_DAYS) continue

    const opened = q.viewed_at
      ? `opened ${daysAgo(q.viewed_at, nowMs)} day${daysAgo(q.viewed_at, nowMs) === 1 ? "" : "s"} ago`
      : "never opened"
    out.push({
      kind: "stale_quote",
      ref: `stale_quote:${q.id}`,
      customerId: q.customer_id,
      leadId: q.lead_id,
      phone: q.customer_phone,
      customerName: q.customer_name,
      why: `Their ${formatPriceUsd(q.total_cents)} quote went out ${silentDays} days ago and was ${opened} — no reply since.`,
      draftIntent:
        "a warm, no-pressure nudge about the quote we sent — offer to answer questions or adjust it",
    })
  }
  return out
}

/** Pipeline cards past their next_action_at (live stages only). */
export function pickFollowUpsDue(
  leads: LeadForSuggestion[],
  now: Date
): SuggestionCandidate[] {
  const nowMs = now.getTime()
  const live: CrmStage[] = ["new", "needs_quote", "quote_sent", "follow_up"]
  const out: SuggestionCandidate[] = []
  for (const l of leads) {
    if (!l.stage || !live.includes(l.stage)) continue
    if (!l.next_action_at || Date.parse(l.next_action_at) > nowMs) continue
    if (!l.phone?.trim()) continue
    const overdue = Math.max(0, daysAgo(l.next_action_at, nowMs))
    const stageLabel = l.stage.replace(/_/g, " ")
    out.push({
      kind: "follow_up_due",
      ref: `follow_up:${l.id}:${l.next_action_at}`,
      customerId: l.customer_id,
      leadId: l.id,
      phone: l.phone,
      customerName: l.customer_name,
      why:
        overdue === 0
          ? `Their pipeline card (${stageLabel}) hit its next-action time today.`
          : `Their pipeline card (${stageLabel}) has been past its next-action time for ${overdue} day${overdue === 1 ? "" : "s"}.`,
      draftIntent:
        "a short, friendly check-in to keep the conversation moving toward booking",
    })
  }
  return out
}

/** Engaged-then-silent leads (21d+), mirroring automation #4's definition. */
export function pickRevivalLeads(
  leads: LeadForSuggestion[],
  now: Date
): SuggestionCandidate[] {
  const nowMs = now.getTime()
  const cutoff = nowMs - REVIVAL_SILENT_DAYS * DAY_MS
  const out: SuggestionCandidate[] = []
  for (const l of leads) {
    if (l.stage === "booked" || l.stage === "lost") continue
    if (!l.phone?.trim()) continue
    if (!l.last_inbound_at) continue // never engaged → not a revival story
    const lastActivity = l.last_activity_at ?? l.last_inbound_at
    if (Date.parse(lastActivity) > cutoff) continue
    if (Date.parse(l.created_at) > cutoff) continue
    const silent = daysAgo(lastActivity, nowMs)
    out.push({
      kind: "lead_revival",
      ref: `revival:${l.id}`,
      customerId: l.customer_id,
      leadId: l.id,
      phone: l.phone,
      customerName: l.customer_name,
      why: `They reached out to us before, but it's been ${silent} days with no activity either way.`,
      draftIntent:
        "a warm re-introduction asking if they're still interested, with an easy opening to book",
    })
  }
  return out
}

/**
 * One suggestion per person per sweep, most actionable first:
 * a stale quote beats a due follow-up beats a revival.
 */
export function dedupeCandidates(
  candidates: SuggestionCandidate[]
): SuggestionCandidate[] {
  const priority: Record<SuggestionKind, number> = {
    stale_quote: 0,
    follow_up_due: 1,
    lead_revival: 2,
  }
  const sorted = [...candidates].sort((a, b) => priority[a.kind] - priority[b.kind])
  const seen = new Set<string>()
  const out: SuggestionCandidate[] = []
  for (const c of sorted) {
    const personKey = c.customerId ?? c.phone.replace(/\D/g, "").slice(-10)
    if (seen.has(personKey)) continue
    seen.add(personKey)
    out.push(c)
  }
  return out
}
