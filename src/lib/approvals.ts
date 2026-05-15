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

import { createCalendarEvent } from "@/lib/aurinko"
import { findCustomerByChannel, findOrCreateCustomer } from "@/lib/customers"
import { recordInteraction } from "@/lib/memory"
import { sendSmsApprovalRequest } from "@/lib/slack"
import { draftBookingConfirmationSms } from "@/lib/sms-drafter"
import { sendOutboundSms } from "@/lib/twilio"
import type {
  LeadStatus,
  PendingActionStatus,
  PendingActionType,
  ShopRow,
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

export type BookingProposal = {
  customer_name: string
  phone: string
  car_info: string | null
  service: string | null
  iso_start_time: string
  duration_minutes: number
  timezone: string | null
  email: string | null
  pin_notes: string | null
}

export type SmsProposal = {
  to_phone: string
  body: string
  customer_name: string | null
  customer_id: string | null
  /** Source-side context — what prompted this draft (e.g. inbound message ID, agent name). */
  reason: string | null
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
  | {
      status: "executed"
      actionType: "book_appointment"
      resultId: string
      proposal: BookingProposal
      calendarEventId: string | null
    }
  | {
      status: "executed"
      actionType: "send_sms"
      resultId: string
      proposal: SmsProposal
      messageSid: string
    }
  | { status: "already_decided" }

export type ApprovalResult =
  | ({ ok: true } & ApprovalSuccess)
  | { ok: false; error: string }

export type DecisionSuccess =
  | { status: "claimed"; actionType: "create_lead"; proposal: LeadProposal }
  | { status: "claimed"; actionType: "add_note"; proposal: NoteProposal }
  | {
      status: "claimed"
      actionType: "book_appointment"
      proposal: BookingProposal
    }
  | { status: "claimed"; actionType: "send_sms"; proposal: SmsProposal }
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
    case "book_appointment":
      return executeBookAppointment(supabase, claimed)
    case "send_sms":
      return executeSendSms(supabase, claimed)
    default:
      await rollbackClaim(supabase, claimed.id)
      return {
        ok: false,
        error: `Unsupported action_type: ${claimed.action_type}`,
      }
  }
}

async function loadShopWithToken(
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

async function executeBookAppointment(
  supabase: SupabaseClient,
  claimed: ClaimedAction
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as BookingProposal

  const start = new Date(proposal.iso_start_time)
  if (Number.isNaN(start.getTime())) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: "Booking start time is not a valid ISO date" }
  }
  const durationMinutes = Number(proposal.duration_minutes) || 90
  const end = new Date(start.getTime() + durationMinutes * 60_000)

  const shop = await loadShopWithToken(supabase, claimed.shop_id)
  if (!shop?.aurinko_access_token) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error:
        "Connect Google Calendar via Aurinko (in /settings) before approving bookings.",
    }
  }

  const customerResult = await findOrCreateCustomer(supabase, claimed.shop_id, {
    name: proposal.customer_name,
    phone: proposal.phone,
    email: proposal.email,
  })
  if (!customerResult.ok) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: `Customer resolution failed: ${customerResult.error}`,
    }
  }

  const calendarId = "primary"
  const subjectParts = [
    proposal.service?.trim() || "Detailing",
    proposal.customer_name?.trim() || "",
  ].filter(Boolean)
  const subject = subjectParts.join(" — ")

  let calendarEventId: string | null = null
  try {
    const created = await createCalendarEvent(shop.aurinko_access_token, calendarId, {
      subject,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      timezone: proposal.timezone ?? "UTC",
      location: shop.location,
      attendeeEmail: proposal.email,
    })
    calendarEventId = created.id || null
  } catch (err) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: `Calendar event create failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  // Lead row tracks the customer relationship; appointment row tracks
  // the calendar event itself. Both link back through customer_id.
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .insert({
      shop_id: claimed.shop_id,
      customer_id: customerResult.customer.id,
      customer_name: proposal.customer_name,
      phone: proposal.phone,
      car_info: proposal.car_info,
      pin_notes: proposal.pin_notes,
      status: "booked",
    })
    .select("id")
    .single()

  if (leadErr || !lead) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: leadErr?.message ?? "Lead insert failed" }
  }

  await supabase.from("appointments").insert({
    shop_id: claimed.shop_id,
    lead_id: lead.id,
    customer_id: customerResult.customer.id,
    scheduled_at: start.toISOString(),
    duration_minutes: durationMinutes,
    service_name: proposal.service,
    aurinko_calendar_id: calendarId,
    aurinko_event_id: calendarEventId,
    timezone: proposal.timezone,
  })

  await supabase
    .from("pending_actions")
    .update({ result_id: lead.id })
    .eq("id", claimed.id)

  // Best-effort confirmation draft. Always after a successful booking
  // landing — drafter/Slack failures must not roll back the booking.
  try {
    await queueBookingConfirmationSms(supabase, shop, proposal, customerResult.customer.id)
  } catch (err) {
    console.warn(
      "[approvals] booking confirmation draft failed (booking still succeeded):",
      err
    )
  }

  return {
    ok: true,
    status: "executed",
    actionType: "book_appointment",
    resultId: lead.id,
    proposal,
    calendarEventId,
  }
}

async function queueBookingConfirmationSms(
  supabase: SupabaseClient,
  shop: ShopRow,
  proposal: BookingProposal,
  customerId: string
): Promise<void> {
  // Skip if the shop hasn't connected SMS — without a Twilio number
  // there's nothing for the operator to eventually approve & send.
  if (!shop.twilio_phone_number) return
  if (!proposal.phone?.trim()) return

  const draft = await draftBookingConfirmationSms({
    shopName: shop.name,
    customerName: proposal.customer_name,
    service: proposal.service,
    isoStartTime: proposal.iso_start_time,
    durationMinutes: proposal.duration_minutes,
    timezone: proposal.timezone,
    vehicle: proposal.car_info,
  })
  if (!draft) return

  const reason = proposal.service?.trim()
    ? `Confirm booking · ${proposal.service.trim()}`
    : "Confirm booking"

  const { data: pending, error: pendingErr } = await supabase
    .from("pending_actions")
    .insert({
      shop_id: shop.id,
      action_type: "send_sms",
      payload: {
        to_phone: proposal.phone,
        body: draft,
        customer_name: proposal.customer_name,
        customer_id: customerId,
        reason,
        source: "booking_confirmation",
        iso_start_time: proposal.iso_start_time,
      },
      requested_by: shop.owner_id,
    })
    .select("id")
    .single()

  if (pendingErr || !pending) {
    console.error(
      "[approvals] booking confirmation pending_action insert failed:",
      pendingErr
    )
    return
  }

  try {
    await sendSmsApprovalRequest({
      pendingActionId: pending.id,
      toPhone: proposal.phone,
      customerName: proposal.customer_name,
      body: draft,
      reason,
    })
  } catch (err) {
    console.error("[approvals] booking confirmation Slack send failed:", err)
  }
}

async function executeSendSms(
  supabase: SupabaseClient,
  claimed: ClaimedAction
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as SmsProposal

  if (!proposal.to_phone?.trim() || !proposal.body?.trim()) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: "SMS proposal is missing recipient or body." }
  }

  const shop = await loadShopWithToken(supabase, claimed.shop_id)
  if (!shop?.twilio_phone_number) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: "Connect SMS in /settings before approving outbound messages.",
    }
  }

  let sendResult
  try {
    sendResult = await sendOutboundSms({
      from: shop.twilio_phone_number,
      to: proposal.to_phone,
      body: proposal.body,
    })
  } catch (err) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: `Twilio send failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  // Best-effort attachment — proposal may already carry customer_id.
  let customerId = proposal.customer_id
  if (!customerId) {
    const customer = await findCustomerByChannel(supabase, claimed.shop_id, {
      phone: proposal.to_phone,
    })
    if (customer) customerId = customer.id
  }

  const interaction = await recordInteraction(supabase, {
    shopId: claimed.shop_id,
    customerId,
    channel: "sms",
    role: "gradia",
    content: proposal.body,
    metadata: {
      direction: "outbound",
      twilio_message_sid: sendResult.messageSid,
      twilio_status: sendResult.status,
      to_phone: proposal.to_phone,
      from_phone: shop.twilio_phone_number,
      pending_action_id: claimed.id,
      reason: proposal.reason ?? null,
    },
  })

  const resultId = interaction.ok ? interaction.id : sendResult.messageSid

  await supabase
    .from("pending_actions")
    .update({ result_id: resultId })
    .eq("id", claimed.id)

  return {
    ok: true,
    status: "executed",
    actionType: "send_sms",
    resultId,
    proposal,
    messageSid: sendResult.messageSid,
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
    case "book_appointment":
      return {
        ok: true,
        status: "claimed",
        actionType: "book_appointment",
        proposal: claimed.payload as unknown as BookingProposal,
      }
    case "send_sms":
      return {
        ok: true,
        status: "claimed",
        actionType: "send_sms",
        proposal: claimed.payload as unknown as SmsProposal,
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
