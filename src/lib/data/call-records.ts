import { createClient } from "@/lib/supabase/server"
import { getOptionalShop } from "@/lib/shop"
import type {
  CallRecordRow,
  InteractionRole,
  PendingActionType,
} from "@/lib/types/database"

/**
 * The call-record page reader (spec §5.2, L4-lite): one call's full
 * artifact — the captured end-of-call report (call_records, L0.5), the
 * verbatim transcript turns (interactions sharing the vapi_call_id),
 * and any actions the call staged (pending_actions whose payload
 * carries the call id) with their decision-log lines. Every section
 * renders only if its data exists — a legacy call with no captured
 * record still shows its transcript.
 */

export type CallTranscriptTurn = {
  id: string
  role: InteractionRole
  content: string
  occurredAt: string
}

export type CallStagedAction = {
  id: string
  actionType: PendingActionType
  status: string
  summary: string
  because: string | null
}

export type CallRecordView = {
  callId: string
  record: CallRecordRow | null
  customerId: string | null
  customerName: string | null
  turns: CallTranscriptTurn[]
  actions: CallStagedAction[]
}

function actionSummary(
  actionType: PendingActionType,
  payload: Record<string, unknown>
): string {
  const name = (payload.customer_name as string)?.trim() || "the caller"
  switch (actionType) {
    case "create_lead":
      return `Lead saved — ${name}`
    case "book_appointment":
      return `Booking proposed — ${name}`
    case "reschedule_appointment":
      return `Reschedule requested — ${name}`
    case "cancel_appointment":
      return `Cancellation requested — ${name}`
    case "send_sms":
      return `Text staged to ${name}`
    case "send_email":
      return `Email staged to ${name}`
    default:
      return `Action staged for ${name}`
  }
}

export async function getCallRecordView(
  callId: string
): Promise<CallRecordView | null> {
  const shop = await getOptionalShop()
  if (!shop) return null
  const supabase = await createClient()

  const [recordRes, turnsRes, actionsRes] = await Promise.all([
    supabase
      .from("call_records")
      .select("*")
      .eq("shop_id", shop.id)
      .eq("vapi_call_id", callId)
      .maybeSingle(),
    supabase
      .from("interactions")
      .select("id, role, content, occurred_at, customer_id")
      .eq("shop_id", shop.id)
      .eq("channel", "voice")
      .eq("metadata->>vapi_call_id", callId)
      .order("occurred_at", { ascending: true })
      .limit(200),
    supabase
      .from("pending_actions")
      .select("id, action_type, payload, status")
      .eq("shop_id", shop.id)
      .eq("payload->>vapi_call_id", callId)
      .order("created_at", { ascending: true }),
  ])

  if (recordRes.error) {
    console.error("[data/call-records] record query failed:", recordRes.error)
  }
  if (turnsRes.error) {
    console.error("[data/call-records] turns query failed:", turnsRes.error)
  }
  if (actionsRes.error) {
    console.error("[data/call-records] actions query failed:", actionsRes.error)
  }

  const record = (recordRes.data as CallRecordRow | null) ?? null

  type TurnRow = {
    id: string
    role: InteractionRole
    content: string
    occurred_at: string
    customer_id: string | null
  }
  const turnRows = (turnsRes.data as TurnRow[] | null) ?? []

  if (!record && turnRows.length === 0) return null

  type ActionRow = {
    id: string
    action_type: PendingActionType
    payload: Record<string, unknown> | null
    status: string
  }
  const actionRows = (actionsRes.data as ActionRow[] | null) ?? []

  const decisionByAction = new Map<string, string>()
  if (actionRows.length > 0) {
    const { data: decisions } = await supabase
      .from("action_decisions")
      .select("pending_action_id, because")
      .eq("shop_id", shop.id)
      .in(
        "pending_action_id",
        actionRows.map((a) => a.id)
      )
    for (const d of (decisions as
      | { pending_action_id: string; because: string }[]
      | null) ?? []) {
      decisionByAction.set(d.pending_action_id, d.because)
    }
  }

  const customerId =
    record?.customer_id ?? turnRows.find((t) => t.customer_id)?.customer_id ?? null
  let customerName: string | null = null
  if (customerId) {
    const { data: cust } = await supabase
      .from("customers")
      .select("name")
      .eq("shop_id", shop.id)
      .eq("id", customerId)
      .maybeSingle()
    customerName = (cust as { name: string | null } | null)?.name ?? null
  }

  return {
    callId,
    record,
    customerId,
    customerName,
    turns: turnRows.map((t) => ({
      id: t.id,
      role: t.role,
      content: t.content,
      occurredAt: t.occurred_at,
    })),
    actions: actionRows.map((a) => ({
      id: a.id,
      actionType: a.action_type,
      status: a.status,
      summary: actionSummary(a.action_type, a.payload ?? {}),
      because: decisionByAction.get(a.id) ?? null,
    })),
  }
}
