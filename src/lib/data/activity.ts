import { createClient } from "@/lib/supabase/server"
import { getOptionalShop } from "@/lib/shop"
import type { PendingActionType } from "@/lib/types/database"

/**
 * The glass-box Activity feed (spec §5.1, L4-lite): a reverse-chron
 * union of what actually happened, from the tables that record it —
 * call_records (answered calls), pending_actions (staged / sent /
 * dropped work), and fired custom_agent_runs. The "because" line comes
 * ONLY from action_decisions rows written at staging time (§8-A6b) —
 * entries without one simply don't show a decision line. Nothing here
 * is reconstructed or generated.
 */

/**
 * `unresolved` is its own outcome, never a flavour of handled: an action was
 * approved or claimed for sending, but no execution result confirms it.
 */
export type ActivityOutcome = "handled" | "needs-you" | "dropped" | "unresolved"

/** What the execution evidence says about one pending action. */
export type ActionEvidence = {
  status: string
  result_id: string | null
  /** The action's consumed sending claim, when one exists. */
  claim: { completed_at: string | null } | null
  /** False when the claim lookup itself failed: nothing can be confirmed. */
  claimsReadable: boolean
}

/**
 * Decides the outcome from stored evidence only. An approval is not a result:
 * "handled" needs a recorded result, and for a message whose sending was
 * claimed, a completed claim. Anything else stays visibly unresolved. This
 * mirrors the Whisper inbox hold definition so the two can never disagree.
 */
export function resolveActionOutcome(
  actionType: PendingActionType,
  evidence: ActionEvidence
): ActivityOutcome {
  const { status, result_id, claim } = evidence
  const message = actionType === "send_sms" || actionType === "send_email"
  if (claim && (!claim.completed_at || !result_id || status !== "approved")) return "unresolved"
  if (status === "pending" || status === "edit_requested") return "needs-you"
  if (status === "rejected") return "dropped"
  if (status !== "approved" || !result_id) return "unresolved"
  if (message && !evidence.claimsReadable) return "unresolved"
  return "handled"
}

export type ActivityFeedItem = {
  id: string
  kind: "call" | "action" | "agent_run"
  at: string
  /** What happened — plain narrator sentence from stored fields. */
  title: string
  /** Supporting stored detail (summary, message preview, run stats). */
  detail: string | null
  /** The decision log's WHY — present only when a row exists. */
  because: string | null
  outcome: ActivityOutcome
  /** Where to inspect it (call record page / approvals). */
  href: string | null
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`
}

export function actionTitle(
  actionType: PendingActionType,
  payload: Record<string, unknown>,
  status: string,
  outcome?: ActivityOutcome
): string {
  const name = (payload.customer_name as string)?.trim() || "a customer"
  const staged = status === "pending" || status === "edit_requested"
  // Never narrate an unconfirmed action in the past tense.
  if (outcome === "unresolved") {
    switch (actionType) {
      case "send_sms":
        return `Text to ${name} — delivery not confirmed`
      case "send_email":
        return `Email to ${name} — delivery not confirmed`
      case "book_appointment":
        return `Booking for ${name} — result not confirmed`
      case "reschedule_appointment":
        return `Reschedule for ${name} — result not confirmed`
      case "cancel_appointment":
        return `Cancellation for ${name} — result not confirmed`
      default:
        return `Action for ${name} — result not confirmed`
    }
  }
  switch (actionType) {
    case "send_sms":
      return staged ? `Staged a text to ${name}` : `Texted ${name}`
    case "send_email":
      return staged ? `Staged an email to ${name}` : `Emailed ${name}`
    case "create_lead":
      return `Logged a lead — ${name}`
    case "add_note":
      return "Saved a note to memory"
    case "book_appointment":
      return staged ? `Proposed a booking for ${name}` : `Booked ${name}`
    case "reschedule_appointment":
      return `Reschedule requested — ${name}`
    case "cancel_appointment":
      return `Cancellation requested — ${name}`
    default:
      return `Handled ${name}`
  }
}

function actionDetail(payload: Record<string, unknown>): string | null {
  const body = (payload.body as string)?.trim()
  if (body) return truncate(body, 140)
  const subject = (payload.subject as string)?.trim()
  if (subject) return truncate(subject, 140)
  const notes = (payload.pin_notes as string)?.trim()
  if (notes) return truncate(notes, 140)
  return null
}

export async function listActivityFeed(limit = 40): Promise<ActivityFeedItem[]> {
  const shop = await getOptionalShop()
  if (!shop) return []
  const supabase = await createClient()

  const [actionsRes, callsRes, runsRes] = await Promise.all([
    supabase
      .from("pending_actions")
      .select("id, action_type, payload, status, result_id, decided_at, created_at")
      .eq("shop_id", shop.id)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("call_records")
      .select(
        "id, vapi_call_id, summary, ended_reason, duration_seconds, started_at, created_at, customer:customers(name)"
      )
      .eq("shop_id", shop.id)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("custom_agent_runs")
      .select("id, fired, reason, stats, created_at, agent:custom_agents(name)")
      .eq("shop_id", shop.id)
      .eq("fired", true)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  for (const [label, res] of [
    ["actions", actionsRes],
    ["calls", callsRes],
    ["runs", runsRes],
  ] as const) {
    if (res.error) console.error(`[data/activity] ${label} query failed:`, res.error)
  }

  type ActionRow = {
    id: string
    action_type: PendingActionType
    payload: Record<string, unknown> | null
    status: string
    result_id: string | null
    decided_at: string | null
    created_at: string
  }
  const actions = ((actionsRes.data as ActionRow[] | null) ?? []).filter(
    (a) => a.status !== "rejected" || a.decided_at // dropped items still log (quietly)
  )

  // The because lines, fetched for exactly these actions.
  const decisionByAction = new Map<string, string>()
  if (actions.length > 0) {
    const { data: decisions, error } = await supabase
      .from("action_decisions")
      .select("pending_action_id, because")
      .eq("shop_id", shop.id)
      .in(
        "pending_action_id",
        actions.map((a) => a.id)
      )
    if (error) {
      console.error("[data/activity] decisions query failed:", error)
    }
    for (const d of (decisions as
      | { pending_action_id: string; because: string }[]
      | null) ?? []) {
      decisionByAction.set(d.pending_action_id, d.because)
    }
  }

  // Consumed sending claims for exactly these actions. A failed lookup is
  // treated as "cannot confirm", never as "nothing was claimed".
  const claimByAction = new Map<string, { completed_at: string | null }>()
  let claimsReadable = true
  if (actions.length > 0) {
    const { data: claims, error } = await supabase
      .from("service_proof_consumptions")
      .select("action_id, completed_at")
      .eq("shop_id", shop.id)
      .in(
        "action_id",
        actions.map((a) => a.id)
      )
    if (error) {
      claimsReadable = false
      console.error("[data/activity] claims query failed:", error)
    }
    for (const c of (claims as
      | { action_id: string; completed_at: string | null }[]
      | null) ?? []) {
      claimByAction.set(c.action_id, { completed_at: c.completed_at })
    }
  }

  const items: ActivityFeedItem[] = []

  for (const a of actions) {
    const payload = a.payload ?? {}
    const outcome = resolveActionOutcome(a.action_type, {
      status: a.status,
      result_id: a.result_id,
      claim: claimByAction.get(a.id) ?? null,
      claimsReadable,
    })
    items.push({
      id: `action:${a.id}`,
      kind: "action",
      at: a.decided_at ?? a.created_at,
      title: actionTitle(a.action_type, payload, a.status, outcome),
      detail: actionDetail(payload),
      because: decisionByAction.get(a.id) ?? null,
      outcome,
      href:
        outcome === "needs-you"
          ? "/approvals"
          : outcome === "unresolved"
            ? `/approvals/${a.id}`
            : null,
    })
  }

  type CallRow = {
    id: string
    vapi_call_id: string
    summary: string | null
    ended_reason: string | null
    duration_seconds: number | null
    started_at: string | null
    created_at: string
    customer: { name: string | null } | null
  }
  for (const c of (callsRes.data as unknown as CallRow[] | null) ?? []) {
    const who = c.customer?.name?.trim() || "a caller"
    const mins = c.duration_seconds
      ? ` · ${Math.max(1, Math.round(c.duration_seconds / 60))} min`
      : ""
    items.push({
      id: `call:${c.id}`,
      kind: "call",
      at: c.started_at ?? c.created_at,
      title: `Answered a call from ${who}${mins}`,
      detail: c.summary ? truncate(c.summary, 160) : null,
      because: null,
      outcome: "handled",
      href: `/calls/${encodeURIComponent(c.vapi_call_id)}`,
    })
  }

  type RunRow = {
    id: string
    fired: boolean
    reason: string | null
    stats: Record<string, number> | null
    created_at: string
    agent: { name: string | null } | null
  }
  for (const r of (runsRes.data as unknown as RunRow[] | null) ?? []) {
    const name = r.agent?.name?.trim() || "An agent"
    const proposed =
      r.stats?.proposed ?? r.stats?.proposed_sms ?? r.stats?.proposed_email ?? 0
    items.push({
      id: `run:${r.id}`,
      kind: "agent_run",
      at: r.created_at,
      title: `${name} ran`,
      detail:
        proposed > 0
          ? `Staged ${proposed} ${proposed === 1 ? "draft" : "drafts"} for your approval`
          : (r.reason?.trim() || null),
      because: null,
      outcome: "handled",
      href: null,
    })
  }

  items.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime())
  return items.slice(0, limit)
}
