/**
 * Shared approval engine. Both the Slack interactivity callback and the
 * /approvals dashboard call into these helpers so the actual claim → execute
 * → finalize flow lives in one place. Helpers take any SupabaseClient — pass
 * a service-role client for Slack callbacks (no user session) or a
 * user-session client for the dashboard (RLS naturally limits scope).
 *
 * Two action types are supported:
 *   - create_lead: insert a row into `leads` (customer auto-resolved)
 *   - add_note:    insert a row into `interactions` (channel='note')
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { findCustomerByChannel, findOrCreateCustomer } from "@/lib/customers"
import { recordInteraction } from "@/lib/memory"
import type {
  LeadStatus,
  PendingActionStatus,
  PendingActionType,
} from "@/lib/types/database"

export type Decider = {
  slackUserId?: string
  userId?: string
}

export type LeadProposal = {
  customer_name: string
  phone: string
  car_info: string | null
  pin_notes: string | null
  status: LeadStatus
}

export type NoteProposal = {
  content: string
  customer_name: string | null
  phone: string | null
}

type ClaimedAction = {
  id: string
  shop_id: string
  action_type: PendingActionType
  payload: Record<string, unknown>
}

export type ApprovalSuccess =
  | {
      status: "executed"
      actionType: "create_lead"
      resultId: string
      proposal: LeadProposal
    }
  | {
      status: "executed"
      actionType: "add_note"
      resultId: string
      proposal: NoteProposal
    }
  | { status: "already_decided" }

export type ApprovalResult =
  | ({ ok: true } & ApprovalSuccess)
  | { ok: false; error: string }

export type DecisionSuccess =
  | { status: "claimed"; actionType: "create_lead"; proposal: LeadProposal }
  | { status: "claimed"; actionType: "add_note"; proposal: NoteProposal }
  | { status: "already_decided" }

export type DecisionResult =
  | ({ ok: true } & DecisionSuccess)
  | { ok: false; error: string }

async function claimPendingAction(
  supabase: SupabaseClient,
  pendingId: string,
  nextStatus: PendingActionStatus,
  decider: Decider
): Promise<ClaimedAction | null> {
  const updates: Record<string, unknown> = {
    status: nextStatus,
    decided_at: new Date().toISOString(),
  }
  if (decider.slackUserId) updates.decided_by_slack = decider.slackUserId
  if (decider.userId) updates.decided_by_user = decider.userId

  const { data, error } = await supabase
    .from("pending_actions")
    .update(updates)
    .eq("id", pendingId)
    .in("status", ["pending", "edit_requested"])
    .select("id, shop_id, action_type, payload")
    .maybeSingle()

  if (error) {
    throw error
  }
  return (data as ClaimedAction | null) ?? null
}

async function rollbackClaim(
  supabase: SupabaseClient,
  pendingId: string
): Promise<void> {
  await supabase
    .from("pending_actions")
    .update({
      status: "pending",
      decided_at: null,
      decided_by_slack: null,
      decided_by_user: null,
    })
    .eq("id", pendingId)
}

async function executeCreateLead(
  supabase: SupabaseClient,
  claimed: ClaimedAction
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as LeadProposal

  const customerResult = await findOrCreateCustomer(supabase, claimed.shop_id, {
    name: proposal.customer_name,
    phone: proposal.phone,
  })

  if (!customerResult.ok) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: `Customer resolution failed: ${customerResult.error}`,
    }
  }

  const { data: created, error: insertErr } = await supabase
    .from("leads")
    .insert({
      shop_id: claimed.shop_id,
      customer_id: customerResult.customer.id,
      customer_name: proposal.customer_name,
      phone: proposal.phone,
      car_info: proposal.car_info,
      pin_notes: proposal.pin_notes,
      status: proposal.status,
    })
    .select("id")
    .single()

  if (insertErr || !created) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: insertErr?.message ?? "Lead insert failed" }
  }

  await supabase
    .from("pending_actions")
    .update({ result_id: created.id })
    .eq("id", claimed.id)

  return {
    ok: true,
    status: "executed",
    actionType: "create_lead",
    resultId: created.id,
    proposal,
  }
}

async function executeAddNote(
  supabase: SupabaseClient,
  claimed: ClaimedAction
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as NoteProposal
  const content = (proposal.content ?? "").trim()

  if (!content) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: "Note content is empty" }
  }

  // Best-effort customer attachment — only if a phone was extracted.
  let customerId: string | null = null
  if (proposal.phone?.trim()) {
    const customer = await findCustomerByChannel(supabase, claimed.shop_id, {
      phone: proposal.phone,
    })
    if (customer) customerId = customer.id
  }

  const result = await recordInteraction(supabase, {
    shopId: claimed.shop_id,
    customerId,
    channel: "note",
    role: "gradia",
    content,
    metadata: {
      source: "whisper",
      pending_action_id: claimed.id,
      mentioned_name: proposal.customer_name ?? null,
      mentioned_phone: proposal.phone ?? null,
    },
  })

  if (!result.ok) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: `Note save failed: ${result.error}` }
  }

  await supabase
    .from("pending_actions")
    .update({ result_id: result.id })
    .eq("id", claimed.id)

  return {
    ok: true,
    status: "executed",
    actionType: "add_note",
    resultId: result.id,
    proposal,
  }
}

/**
 * Atomically claims a pending action and executes it. Idempotent — a second
 * call with the same id returns `already_decided`. On execution failure, the
 * row is rolled back to `pending` so the human can retry.
 */
export async function executeApproval(
  supabase: SupabaseClient,
  pendingId: string,
  decider: Decider
): Promise<ApprovalResult> {
  let claimed: ClaimedAction | null
  try {
    claimed = await claimPendingAction(supabase, pendingId, "approved", decider)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (!claimed) {
    return { ok: true, status: "already_decided" }
  }

  switch (claimed.action_type) {
    case "create_lead":
      return executeCreateLead(supabase, claimed)
    case "add_note":
      return executeAddNote(supabase, claimed)
    default:
      await rollbackClaim(supabase, claimed.id)
      return {
        ok: false,
        error: `Unsupported action_type: ${claimed.action_type}`,
      }
  }
}

function decisionFromClaim(claimed: ClaimedAction): DecisionResult {
  switch (claimed.action_type) {
    case "create_lead":
      return {
        ok: true,
        status: "claimed",
        actionType: "create_lead",
        proposal: claimed.payload as unknown as LeadProposal,
      }
    case "add_note":
      return {
        ok: true,
        status: "claimed",
        actionType: "add_note",
        proposal: claimed.payload as unknown as NoteProposal,
      }
    default:
      return {
        ok: false,
        error: `Unsupported action_type: ${claimed.action_type}`,
      }
  }
}

/** Marks the proposal for revision (Slack Edit button). No DB writes besides the claim. */
export async function markEditRequested(
  supabase: SupabaseClient,
  pendingId: string,
  decider: Decider
): Promise<DecisionResult> {
  let claimed: ClaimedAction | null
  try {
    claimed = await claimPendingAction(
      supabase,
      pendingId,
      "edit_requested",
      decider
    )
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (!claimed) {
    return { ok: true, status: "already_decided" }
  }

  return decisionFromClaim(claimed)
}

/** Drops the proposal permanently (dashboard Reject button). */
export async function executeRejection(
  supabase: SupabaseClient,
  pendingId: string,
  decider: Decider
): Promise<DecisionResult> {
  let claimed: ClaimedAction | null
  try {
    claimed = await claimPendingAction(
      supabase,
      pendingId,
      "rejected",
      decider
    )
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (!claimed) {
    return { ok: true, status: "already_decided" }
  }

  return decisionFromClaim(claimed)
}
