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

import { dispatchAgentEvent } from "@/lib/agent-events"
import {
  blockingConflicts,
  checkAvailability,
  emitConflictEvent,
  internalFailureCode,
  resolveConflictPolicy,
  summarizeAvailability,
  unverifiedAvailabilitySummary,
  validateConflictOverride,
  type AvailabilitySummary,
  type ConflictOverride,
  type ConflictPolicyContext,
} from "@/lib/availability"
import {
  coveredAppointmentIds,
  writeAppointmentSerialized,
  type SerializedWriteResult,
} from "@/lib/appointment-write"
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getAccessTokenForShop as getAurinkoAccessTokenForShop,
  sendEmailMessage,
  updateCalendarEventTime,
} from "@/lib/aurinko"
import { recordActionDecision } from "@/lib/decision-log"
import { FEATURES } from "@/lib/features"
import { recordUsage } from "@/lib/credits"
import { getPricing, priceUsage, smsSegments } from "@/lib/pricing"
import { findCustomerByChannel, findOrCreateCustomer } from "@/lib/customers"
import { pushBookingToCrm, pushLeadToCrm } from "@/lib/crm-provider"
import { recordInteraction } from "@/lib/memory"
import { evaluateSmsSendPolicy, type SendCategory } from "@/lib/send-policy"
import { moveLeadToStage, stageFromLegacyStatus } from "@/lib/pipeline"
import { buildQuoteLineItem, computeQuoteTotals } from "@/lib/quotes"
import { parseVehicle } from "@/lib/vehicle"
import { upsertCustomerVehicle, vehiclesByCustomerIds } from "@/lib/vehicles"
import { sendSmsApprovalRequest } from "@/lib/slack"
import { draftBookingConfirmationSms } from "@/lib/sms-drafter"
import { smsGateForShop } from "@/lib/telephony-provider"
import {
  defaultStatusCallbackUrl,
  resolveTwilioCredentials,
  sendOutboundSms,
} from "@/lib/twilio"
import type {
  AppointmentRow,
  LeadStatus,
  PendingActionStatus,
  PendingActionType,
  ServiceRow,
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
  /** Safe-send classification (B2). Marketing needs consent/EBR; defaults transactional. */
  category?: SendCategory
}

export type EmailProposal = {
  to_email: string
  subject: string
  body: string
  customer_name: string | null
  customer_id: string | null
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
      actionType: "reschedule_appointment"
      resultId: string
      proposal: Record<string, unknown>
    }
  | {
      status: "executed"
      actionType: "cancel_appointment"
      resultId: string
      proposal: Record<string, unknown>
    }
  | {
      status: "executed"
      actionType: "send_sms"
      resultId: string
      proposal: SmsProposal
      messageSid: string
    }
  | {
      status: "executed"
      actionType: "send_email"
      resultId: string
      proposal: EmailProposal
    }
  | {
      status: "executed"
      actionType: "create_quote"
      resultId: string
      proposal: Record<string, unknown>
    }
  | { status: "already_decided" }

export type ApprovalResult =
  | ({ ok: true } & ApprovalSuccess)
  | {
      ok: false
      error: string
      /** Structured conflict info when an availability refusal caused the
       *  failure (P0-004) — the same summary written back onto the card. */
      availability?: AvailabilitySummary
    }

export type DecisionSuccess =
  | { status: "claimed"; actionType: "create_lead"; proposal: LeadProposal }
  | { status: "claimed"; actionType: "add_note"; proposal: NoteProposal }
  | {
      status: "claimed"
      actionType: "book_appointment"
      proposal: BookingProposal
    }
  | { status: "claimed"; actionType: "send_sms"; proposal: SmsProposal }
  | {
      status: "claimed"
      actionType: "reschedule_appointment"
      proposal: Record<string, unknown>
    }
  | {
      status: "claimed"
      actionType: "cancel_appointment"
      proposal: Record<string, unknown>
    }
  | { status: "claimed"; actionType: "send_email"; proposal: EmailProposal }
  | {
      status: "claimed"
      actionType: "create_quote"
      proposal: Record<string, unknown>
    }
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

  // Structured vehicle (L3/C1) — parse car_info once, land it in the
  // vehicles table on the customer (also write-through to the deprecated
  // flat columns), and link the lead to it after insert. vehicle_id lives
  // OUTSIDE the insert so a pre-C1-migration DB still creates the lead.
  const vehicle = parseVehicle(proposal.car_info)
  const vehicleId = await upsertCustomerVehicle(
    supabase,
    claimed.shop_id,
    customerResult.customer.id,
    vehicle
  )

  const { data: created, error: insertErr } = await supabase
    .from("leads")
    .insert({
      shop_id: claimed.shop_id,
      customer_id: customerResult.customer.id,
      customer_name: proposal.customer_name,
      phone: proposal.phone,
      car_info: proposal.car_info,
      vehicle_make: vehicle.make,
      vehicle_model: vehicle.model,
      vehicle_year: vehicle.year,
      vehicle_color: vehicle.color,
      pin_notes: proposal.pin_notes,
      status: proposal.status,
    })
    .select("id")
    .single()

  if (insertErr || !created) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: insertErr?.message ?? "Lead insert failed" }
  }

  if (vehicleId) {
    // Best-effort — only reachable when the C1 migration is applied.
    await supabase
      .from("leads")
      .update({ vehicle_id: vehicleId })
      .eq("id", created.id)
  }
  // Auto-move (C2, code): an agent-captured lead lands on the board.
  await moveLeadToStage(
    supabase,
    claimed.shop_id,
    created.id,
    stageFromLegacyStatus(proposal.status),
    { by: "system" }
  )

  await supabase
    .from("pending_actions")
    .update({ result_id: created.id })
    .eq("id", claimed.id)

  // Best-effort CRM push (Jobber, Housecall Pro, …). Never blocks the
  // approval; the seam pushes to every connected CRM independently.
  try {
    await pushLeadToCrm({
      supabase,
      shopId: claimed.shop_id,
      customerId: customerResult.customer.id,
      customerName: proposal.customer_name,
      phone: proposal.phone || null,
    })
  } catch (err) {
    console.warn("[approvals] CRM lead push failed:", err)
  }

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
export type ExecuteApprovalOptions = {
  /**
   * Which D-015/D-016 policy governs calendar writes in this call:
   * "hitl" (default — a human clicked approve) may override a conflict with
   * documented metadata; "automatic" (autopilot / maybeAutoExecute) hard-
   * blocks conflicts, and any override metadata on the payload is IGNORED.
   */
  context?: ConflictPolicyContext
}

export async function executeApproval(
  supabase: SupabaseClient,
  pendingId: string,
  decider: Decider,
  options?: ExecuteApprovalOptions
): Promise<ApprovalResult> {
  const context: ConflictPolicyContext = options?.context ?? "hitl"
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
      return executeBookAppointment(supabase, claimed, { context, decider })
    case "reschedule_appointment":
      return executeRescheduleAppointment(supabase, claimed, {
        context,
        decider,
      })
    case "cancel_appointment":
      return executeCancelAppointment(supabase, claimed)
    case "send_sms":
      return executeSendSms(supabase, claimed)
    case "send_email":
      return executeSendEmail(supabase, claimed)
    case "create_quote":
      return executeCreateQuote(supabase, claimed)
    default:
      await rollbackClaim(supabase, claimed.id)
      return {
        ok: false,
        error: `Unsupported action_type: ${claimed.action_type}`,
      }
  }
}

// ---------------------------------------------------------------------------
// P0-004 — execution-time conflict gate (the authoritative check)
// ---------------------------------------------------------------------------

type CalendarExecutionContext = {
  context: ConflictPolicyContext
  decider: Decider
}

type ConflictGateResult =
  | {
      allowed: true
      summary: AvailabilitySummary | null
      override: ConflictOverride | null
    }
  | { allowed: false; error: string; summary: AvailabilitySummary }

/**
 * Re-checks availability at claim time and applies D-015/D-016:
 *   automatic → blocking conflicts hard-refuse; overrides are ignored.
 *   hitl      → blocking conflicts need a valid, authorized, covering
 *               override recorded on the payload (validateConflictOverride).
 * INTERNAL check failure (Gradia's own schedule data unreadable — shop
 * lookup, appointments query, capped fetch, invalid range) fails CLOSED for
 * BOTH contexts (founder policy): no execution, no override offered, the
 * card stays pending/retryable with a structured verification-failure
 * summary. This is distinct from EXTERNAL calendar degradation (timeout /
 * provider error / not connected), which stays advisory: the check itself
 * succeeds, the result carries `calendar: "unchecked"` with its reason, and
 * execution proceeds on Gradia's own data (D-013). Advisory conflicts
 * (hours/capacity) never refuse.
 */
async function evaluateConflictGate(
  supabase: SupabaseClient,
  claimed: ClaimedAction,
  exec: CalendarExecutionContext,
  range: { start: Date; end: Date; excludeAppointmentId?: string | null }
): Promise<ConflictGateResult> {
  if (!FEATURES.conflictEnforcement) {
    return { allowed: true, summary: null, override: null }
  }
  const checkedAt = new Date().toISOString()
  const policy = resolveConflictPolicy(exec.context)

  let summary: AvailabilitySummary
  let blocking: ReturnType<typeof blockingConflicts>
  try {
    const result = await checkAvailability(supabase, claimed.shop_id, {
      start: range.start,
      end: range.end,
      excludeAppointmentId: range.excludeAppointmentId ?? null,
    })
    summary = summarizeAvailability(result, checkedAt)
    blocking = blockingConflicts(result)
  } catch (err) {
    // Internal failure → fail closed for BOTH contexts (founder policy).
    // Without a completed Gradia-data check there is no honest "clear", and
    // an override cannot apply — there is no conflict list to override.
    const code = internalFailureCode(err)
    console.warn(
      `[availability] execution-time check failed for shop ${claimed.shop_id} action ${claimed.id} (code=${code}, context=${exec.context}) — refusing, card stays pending:`,
      err instanceof Error ? err.message : err
    )
    return {
      allowed: false,
      error:
        exec.context === "automatic"
          ? "Couldn't verify the slot is free (Gradia's schedule data wasn't readable), so the automatic booking was refused — the card is waiting in Approvals; try again shortly."
          : "Couldn't verify the schedule — Gradia's own availability data wasn't readable, so nothing was booked. This isn't a conflict and can't be overridden; the card stays in Approvals — try again shortly.",
      summary: unverifiedAvailabilitySummary(checkedAt, code),
    }
  }

  if (blocking.length === 0) {
    return { allowed: true, summary, override: null }
  }

  const conflictKeys = summary.conflicts
    .filter((c) => c.severity === "blocking")
    .map((c) => c.key)
  emitConflictEvent("booking_conflict_detected", {
    shopId: claimed.shop_id,
    path: `execute:${claimed.action_type}`,
    actionId: claimed.id,
    conflictKeys,
  })

  if (policy === "hard_block") {
    emitConflictEvent("booking_conflict_blocked_automatic", {
      shopId: claimed.shop_id,
      path: `execute:${claimed.action_type}`,
      actionId: claimed.id,
      conflictKeys,
    })
    return {
      allowed: false,
      error: `That slot is already taken (${blocking[0].label}) — automatic booking refused; it's waiting in Approvals.`,
      summary,
    }
  }

  const overrideCheck = validateConflictOverride(
    (claimed.payload as { conflict_override?: unknown }).conflict_override,
    { approverUserId: exec.decider.userId ?? null, blocking }
  )
  if (!overrideCheck.ok) {
    return {
      allowed: false,
      error: `This time conflicts with ${blocking[0].label} — review the warning and use "Book it anyway" to override (${overrideCheck.reason}).`,
      summary,
    }
  }

  emitConflictEvent("booking_conflict_overridden", {
    shopId: claimed.shop_id,
    path: `execute:${claimed.action_type}`,
    actionId: claimed.id,
    conflictKeys,
  })
  return { allowed: true, summary, override: overrideCheck.override }
}

/** Writes the refreshed availability summary onto the card so the returned-
 *  to-pending card shows current conflicts. Best-effort — a failed write
 *  never masks the refusal itself. */
async function recordAvailabilityOnCard(
  supabase: SupabaseClient,
  claimed: ClaimedAction,
  summary: AvailabilitySummary,
  override: ConflictOverride | null
): Promise<void> {
  const payload: Record<string, unknown> = {
    ...claimed.payload,
    availability: summary,
  }
  if (override) payload.conflict_override = override
  const { error } = await supabase
    .from("pending_actions")
    .update({ payload })
    .eq("id", claimed.id)
  if (error) {
    console.warn(
      `[availability] payload availability write failed for action ${claimed.id}: ${error.message}`
    )
  }
}

/**
 * Honest post-race summary: when the serialized write refuses (a conflicting
 * row landed between the gate's check and the write), re-run the central
 * service so the returned-to-pending card shows CURRENT, labeled conflicts.
 * A failed re-run degrades to the structured verification-failure summary —
 * never a fabricated "no conflicts".
 */
async function refreshConflictSummary(
  supabase: SupabaseClient,
  claimed: ClaimedAction,
  range: { start: Date; end: Date; excludeAppointmentId?: string | null }
): Promise<AvailabilitySummary> {
  const checkedAt = new Date().toISOString()
  try {
    const result = await checkAvailability(supabase, claimed.shop_id, {
      start: range.start,
      end: range.end,
      excludeAppointmentId: range.excludeAppointmentId ?? null,
    })
    return summarizeAvailability(result, checkedAt)
  } catch (err) {
    return unverifiedAvailabilitySummary(checkedAt, internalFailureCode(err))
  }
}

/**
 * Explicit reconciliation state (P0-004A): when a post-persistence step
 * fails (lead bookkeeping, external calendar sync), the condition is
 * recorded on the action payload so no contradicting state is silent.
 * Best-effort — a failed write never masks the outcome it describes.
 */
async function recordPayloadReconciliation(
  supabase: SupabaseClient,
  claimed: ClaimedAction,
  patch: Record<string, unknown>
): Promise<void> {
  const { data } = await supabase
    .from("pending_actions")
    .select("payload")
    .eq("id", claimed.id)
    .maybeSingle()
  const current =
    ((data as { payload?: Record<string, unknown> } | null)?.payload ??
      claimed.payload) as Record<string, unknown>
  const { error } = await supabase
    .from("pending_actions")
    .update({ payload: { ...current, ...patch } })
    .eq("id", claimed.id)
  if (error) {
    console.warn(
      `[approvals] reconciliation payload write failed for action ${claimed.id}: ${error.message}`
    )
  }
}

/** Audit evidence for an executed override (D-016): one decision-log row
 *  recording who booked through which conflicts, and why. */
async function recordOverrideDecision(
  supabase: SupabaseClient,
  claimed: ClaimedAction,
  override: ConflictOverride,
  summary: AvailabilitySummary
): Promise<void> {
  await recordActionDecision(supabase, {
    shopId: claimed.shop_id,
    pendingActionId: claimed.id,
    source: "conflict_override",
    because: `Booked despite a schedule conflict because the owner explicitly overrode it — reason: ${override.reason ?? "(none)"}.`,
    inputs: {
      rule: "conflict_override",
      overridden_by: override.by,
      overridden_at: override.at,
      conflicts: override.conflicts,
      conflict_labels: summary.conflicts
        .filter((c) => c.severity === "blocking")
        .map((c) => c.label),
    },
  })
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

type AppointmentChangeProposal = {
  appointment_id?: string | null
  current_scheduled_at?: string | null
  service?: string | null
  customer_name?: string | null
  phone?: string | null
  new_when?: string | null
  iso_new_start_time?: string | null
  reason?: string | null
}

async function loadAppointmentForChange(
  supabase: SupabaseClient,
  shopId: string,
  proposal: AppointmentChangeProposal
): Promise<AppointmentRow | null> {
  if (!proposal.appointment_id) return null
  const { data } = await supabase
    .from("appointments")
    .select("*")
    .eq("shop_id", shopId)
    .eq("id", proposal.appointment_id)
    .maybeSingle()
  return (data as AppointmentRow | null) ?? null
}

/**
 * Reschedule executor (ALWAYS_HITL — runs only on human approve). Moves
 * the calendar event when one is linked, then the appointments row. Needs
 * a parseable new time — without one the approver edits the card first.
 */
async function executeRescheduleAppointment(
  supabase: SupabaseClient,
  claimed: ClaimedAction,
  exec: CalendarExecutionContext
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as AppointmentChangeProposal

  const newStart = proposal.iso_new_start_time
    ? new Date(proposal.iso_new_start_time)
    : null
  if (!newStart || Number.isNaN(newStart.getTime())) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: `No exact new time on this request ("${proposal.new_when ?? "?"}") — edit it in before approving.`,
    }
  }

  const appointment = await loadAppointmentForChange(
    supabase,
    claimed.shop_id,
    proposal
  )
  if (!appointment) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: "Couldn't match this to a booking — find it in Schedule and move it there.",
    }
  }

  const durationMinutes = appointment.duration_minutes ?? 90
  const newEnd = new Date(newStart.getTime() + durationMinutes * 60_000)

  // P0-004: authoritative availability re-check at claim time. The moving
  // appointment excludes itself (and its mirrored calendar event).
  const gate = await evaluateConflictGate(supabase, claimed, exec, {
    start: newStart,
    end: newEnd,
    excludeAppointmentId: appointment.id,
  })
  if (!gate.allowed) {
    await recordAvailabilityOnCard(supabase, claimed, gate.summary, null)
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: gate.error, availability: gate.summary }
  }

  // P0-004A: Gradia durable state FIRST — the serialized move (ends_at rides
  // with scheduled_at, P0-004 gate 8; in-lock re-verify closes the TOCTOU
  // window between the gate above and this write).
  let write: SerializedWriteResult
  try {
    write = await writeAppointmentSerialized(supabase, claimed.shop_id, {
      mode: "move",
      appointmentId: appointment.id,
      start: newStart,
      end: newEnd,
      coveredIds: gate.override
        ? coveredAppointmentIds(gate.override.conflicts)
        : [],
      // Overlap refusal follows the rollout flag; lock + idempotency always on.
      enforceConflicts: FEATURES.conflictEnforcement,
    })
  } catch (err) {
    console.error(
      `[approvals] appointment move failed for action ${claimed.id} — nothing was moved:`,
      err instanceof Error ? err.message : err
    )
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: `Appointment update failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (write.status === "conflict" || write.status === "not_found") {
    const summary = await refreshConflictSummary(supabase, claimed, {
      start: newStart,
      end: newEnd,
      excludeAppointmentId: appointment.id,
    })
    await recordAvailabilityOnCard(supabase, claimed, summary, null)
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error:
        write.status === "not_found"
          ? "Couldn't match this to a booking — find it in Schedule and move it there."
          : "That slot was taken while this card waited — nothing was moved. Review the refreshed conflict and approve again or pick a new time.",
      availability: summary,
    }
  }

  await supabase
    .from("pending_actions")
    .update({ result_id: appointment.id })
    .eq("id", claimed.id)

  // Audit trail — after authoritative persistence: an executed override is
  // recorded (D-016); a degraded check is recorded as "unverified" — never
  // rewritten as clear.
  if (gate.summary && (gate.override || gate.summary.error)) {
    await recordAvailabilityOnCard(supabase, claimed, gate.summary, gate.override)
  }
  if (gate.override && gate.summary) {
    await recordOverrideDecision(supabase, claimed, gate.override, gate.summary)
  }

  // External calendar sync SECOND: the mirror follows the truth. A provider
  // failure here never un-moves the Gradia booking; it is recorded as a
  // synchronization/reconciliation condition.
  if (appointment.aurinko_event_id && appointment.aurinko_calendar_id) {
    try {
      const shop = await loadShopWithToken(supabase, claimed.shop_id)
      const accessToken = shop
        ? await getAurinkoAccessTokenForShop(supabase, shop)
        : null
      if (!accessToken) {
        throw new Error("calendar not connected / token unavailable")
      }
      await updateCalendarEventTime(
        accessToken,
        appointment.aurinko_calendar_id,
        appointment.aurinko_event_id,
        {
          startIso: newStart.toISOString(),
          endIso: newEnd.toISOString(),
          timezone: appointment.timezone,
        }
      )
    } catch (err) {
      console.error(
        `[approvals] calendar sync failed for moved appointment ${appointment.id} (action ${claimed.id}) — move stands; sync needs reconciliation:`,
        err instanceof Error ? err.message : err
      )
      await recordPayloadReconciliation(supabase, claimed, {
        calendar_sync: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        },
      })
    }
  }

  await recordInteraction(supabase, {
    shopId: claimed.shop_id,
    customerId: appointment.customer_id,
    channel: "voice",
    role: "system",
    content: `Rescheduled ${proposal.service ?? "appointment"} to ${newStart.toISOString()} (was ${proposal.current_scheduled_at ?? "?"}).`,
    metadata: { pending_action_id: claimed.id },
  })

  return {
    ok: true,
    status: "executed",
    actionType: "reschedule_appointment",
    resultId: appointment.id,
    proposal,
  }
}

/** Cancel executor (ALWAYS_HITL). Deletes the linked calendar event when
 *  present, then removes the appointments row. */
async function executeCancelAppointment(
  supabase: SupabaseClient,
  claimed: ClaimedAction
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as AppointmentChangeProposal

  const appointment = await loadAppointmentForChange(
    supabase,
    claimed.shop_id,
    proposal
  )
  if (!appointment) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: "Couldn't match this to a booking — find it in Schedule and cancel it there.",
    }
  }

  if (appointment.aurinko_event_id && appointment.aurinko_calendar_id) {
    const shop = await loadShopWithToken(supabase, claimed.shop_id)
    let accessToken: string | null = null
    if (shop) {
      try {
        accessToken = await getAurinkoAccessTokenForShop(supabase, shop)
      } catch (err) {
        console.warn("[approvals] Aurinko token refresh failed:", err)
      }
    }
    if (accessToken) {
      try {
        await deleteCalendarEvent(
          accessToken,
          appointment.aurinko_calendar_id,
          appointment.aurinko_event_id
        )
      } catch (err) {
        await rollbackClaim(supabase, claimed.id)
        return {
          ok: false,
          error: `Calendar delete failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  }

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", appointment.id)
  if (error) {
    return { ok: false, error: `Appointment delete failed: ${error.message}` }
  }

  await supabase
    .from("pending_actions")
    .update({ result_id: appointment.id })
    .eq("id", claimed.id)

  await recordInteraction(supabase, {
    shopId: claimed.shop_id,
    customerId: appointment.customer_id,
    channel: "voice",
    role: "system",
    content: `Cancelled ${proposal.service ?? "appointment"} scheduled for ${proposal.current_scheduled_at ?? "?"}${proposal.reason ? ` — reason: ${proposal.reason}` : ""}.`,
    metadata: { pending_action_id: claimed.id },
  })

  return {
    ok: true,
    status: "executed",
    actionType: "cancel_appointment",
    resultId: appointment.id,
    proposal,
  }
}

async function executeBookAppointment(
  supabase: SupabaseClient,
  claimed: ClaimedAction,
  exec: CalendarExecutionContext
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as BookingProposal

  const start = new Date(proposal.iso_start_time)
  if (Number.isNaN(start.getTime())) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: "Booking start time is not a valid ISO date" }
  }
  const durationMinutes = Number(proposal.duration_minutes) || 90
  const end = new Date(start.getTime() + durationMinutes * 60_000)

  // P0-004A replay fast-path: if THIS action already produced its durable
  // appointment (re-driven claim after a crash/retry), the booking is done —
  // return executed idempotently. Without this, the action's own persisted
  // row would read as a conflict against its own replay. The serialized
  // write's in-lock `exists` check remains the race-safe backstop.
  {
    const { data: prior } = await supabase
      .from("appointments")
      .select("id")
      .eq("shop_id", claimed.shop_id)
      .eq("pending_action_id", claimed.id)
      .maybeSingle()
    const priorId = (prior as { id: string } | null)?.id
    if (priorId) {
      console.warn(
        `[approvals] booking replay for action ${claimed.id} — appointment ${priorId} already exists; returning executed idempotently`
      )
      return {
        ok: true,
        status: "executed",
        actionType: "book_appointment",
        resultId: priorId,
        proposal,
        calendarEventId: null,
      }
    }
  }

  // P0-004: authoritative availability re-check at claim time — data may
  // have changed since this card was staged.
  const gate = await evaluateConflictGate(supabase, claimed, exec, {
    start,
    end,
  })
  if (!gate.allowed) {
    await recordAvailabilityOnCard(supabase, claimed, gate.summary, null)
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: gate.error, availability: gate.summary }
  }

  const shop = await loadShopWithToken(supabase, claimed.shop_id)
  let accessToken: string | null = null
  if (shop) {
    try {
      accessToken = await getAurinkoAccessTokenForShop(supabase, shop)
    } catch (err) {
      console.warn("[approvals] Aurinko token refresh failed:", err)
    }
  }
  if (!shop || !accessToken) {
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

  // -------------------------------------------------------------------------
  // P0-004A (issue #13): Gradia durable booking state FIRST. The serialized,
  // idempotent appointment write is the authoritative transaction; external
  // calendar sync happens after it and can no longer abort, orphan, or
  // misreport a booking.
  // -------------------------------------------------------------------------
  const vehicle = parseVehicle(proposal.car_info)
  const vehicleId = await upsertCustomerVehicle(
    supabase,
    claimed.shop_id,
    customerResult.customer.id,
    vehicle
  )

  let write: SerializedWriteResult
  try {
    write = await writeAppointmentSerialized(supabase, claimed.shop_id, {
      mode: "insert",
      start,
      end,
      coveredIds: gate.override
        ? coveredAppointmentIds(gate.override.conflicts)
        : [],
      pendingActionId: claimed.id,
      customerId: customerResult.customer.id,
      durationMinutes,
      serviceName: proposal.service,
      timezone: proposal.timezone,
      // Overlap refusal follows the rollout flag; lock + idempotency always on.
      enforceConflicts: FEATURES.conflictEnforcement,
    })
  } catch (err) {
    // Persistence failure: never "executed" without a durable row.
    console.error(
      `[approvals] appointment write failed for action ${claimed.id} — nothing was booked:`,
      err instanceof Error ? err.message : err
    )
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: `Booking could not be saved — nothing was booked. ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (write.status === "conflict" || write.status === "not_found") {
    // TOCTOU loser: a conflicting row landed between the gate's check and
    // the serialized write. Refuse with an honest refreshed summary; the
    // card returns to pending for a retry or a new override.
    const summary = await refreshConflictSummary(supabase, claimed, {
      start,
      end,
    })
    await recordAvailabilityOnCard(supabase, claimed, summary, null)
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error:
        "That slot was taken while this card waited — nothing was booked. Review the refreshed conflict and approve again or pick a new time.",
      availability: summary,
    }
  }

  const appointmentId = write.id
  if (write.status === "exists") {
    // Idempotent replay (re-driven claim): the durable row wins; no second
    // round of side effects, no duplicate appointment.
    console.warn(
      `[approvals] booking replay for action ${claimed.id} — appointment ${appointmentId} already exists; returning executed idempotently`
    )
    return {
      ok: true,
      status: "executed",
      actionType: "book_appointment",
      resultId: appointmentId,
      proposal,
      calendarEventId: null,
    }
  }

  // Audit trail — written only now, AFTER authoritative persistence (the
  // d43ce16 gating, preserved and strengthened: a failed or conflicting
  // write returns above, so a "booked despite a conflict" override can never
  // be recorded for a booking that did not persist).
  if (gate.summary && (gate.override || gate.summary.error)) {
    await recordAvailabilityOnCard(supabase, claimed, gate.summary, gate.override)
  }
  if (gate.override && gate.summary) {
    await recordOverrideDecision(supabase, claimed, gate.override, gate.summary)
  }

  // Lead + CRM bookkeeping. The appointment row is the booking truth — a
  // lead failure below is explicit reconciliation state, never a reason to
  // report the booking failed.
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .insert({
      shop_id: claimed.shop_id,
      customer_id: customerResult.customer.id,
      customer_name: proposal.customer_name,
      phone: proposal.phone,
      car_info: proposal.car_info,
      vehicle_make: vehicle.make,
      vehicle_model: vehicle.model,
      vehicle_year: vehicle.year,
      vehicle_color: vehicle.color,
      pin_notes: proposal.pin_notes,
      status: "booked",
    })
    .select("id")
    .single()
  const leadId = (lead as { id: string } | null)?.id ?? null

  if (leadErr || !leadId) {
    console.error(
      `[approvals] lead insert failed for action ${claimed.id} — appointment ${appointmentId} IS booked; lead bookkeeping needs reconciliation: ${leadErr?.message ?? "no row returned"}`
    )
    await recordPayloadReconciliation(supabase, claimed, {
      reconciliation: {
        kind: "lead_missing",
        appointment_id: appointmentId,
        error: leadErr?.message ?? "no row returned",
        at: new Date().toISOString(),
      },
    })
  } else {
    await supabase
      .from("appointments")
      .update({ lead_id: leadId })
      .eq("id", appointmentId)
      .eq("shop_id", claimed.shop_id)
    if (vehicleId) {
      // Best-effort — only reachable when the C1 migration is applied.
      await supabase
        .from("leads")
        .update({ vehicle_id: vehicleId })
        .eq("id", leadId)
    }
    // Auto-move (C2, code): booking approved → booked card + lifecycle flip.
    await moveLeadToStage(supabase, claimed.shop_id, leadId, "booked", {
      by: "system",
    })
  }
  {
    const { error: lifecycleErr } = await supabase
      .from("customers")
      .update({ lifecycle: "active" })
      .eq("id", customerResult.customer.id)
      .eq("shop_id", claimed.shop_id)
    if (lifecycleErr) {
      console.warn("[approvals] lifecycle flip skipped (pre-C1?):", lifecycleErr.message)
    }
  }

  // L3: advance the customer's last-visit recency (excludes them from win-back
  // for a while). The parsed vehicle already landed in `vehicles` above.
  await supabase
    .from("customers")
    .update({ last_visit_at: start.toISOString() })
    .eq("id", customerResult.customer.id)
    .or(`last_visit_at.is.null,last_visit_at.lt.${start.toISOString()}`)

  if (vehicleId) {
    // Best-effort — appointments.vehicle_id exists only post-C1-migration.
    await supabase
      .from("appointments")
      .update({ vehicle_id: vehicleId })
      .eq("id", appointmentId)
  }

  await supabase
    .from("pending_actions")
    .update({ result_id: leadId ?? appointmentId })
    .eq("id", claimed.id)

  // External calendar sync SECOND (P0-004A ordering invariant): the event is
  // created only after the durable Gradia row exists — no orphan events. A
  // provider failure here never erases the booking; it is recorded as a
  // synchronization/reconciliation condition, not a failed Gradia booking.
  const calendarId = "primary"
  const subjectParts = [
    proposal.service?.trim() || "Detailing",
    proposal.customer_name?.trim() || "",
  ].filter(Boolean)
  const subject = subjectParts.join(" — ")

  let calendarEventId: string | null = null
  try {
    const created = await createCalendarEvent(accessToken, calendarId, {
      subject,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      timezone: proposal.timezone ?? "UTC",
      location: shop.location,
      attendeeEmail: proposal.email,
    })
    calendarEventId = created.id || null
    if (calendarEventId) {
      const { error: linkErr } = await supabase
        .from("appointments")
        .update({
          aurinko_calendar_id: calendarId,
          aurinko_event_id: calendarEventId,
        })
        .eq("id", appointmentId)
        .eq("shop_id", claimed.shop_id)
      if (linkErr) {
        console.error(
          `[approvals] calendar event ${calendarEventId} created but not linked to appointment ${appointmentId} — reconcile: ${linkErr.message}`
        )
      }
    }
  } catch (err) {
    console.error(
      `[approvals] calendar sync failed for appointment ${appointmentId} (action ${claimed.id}) — booking stands; sync needs reconciliation:`,
      err instanceof Error ? err.message : err
    )
    await recordPayloadReconciliation(supabase, claimed, {
      calendar_sync: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      },
    })
  }

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

  // Best-effort CRM push — find-or-create the customer + create a
  // job/request with the agreed time in every connected CRM. Failures
  // never roll back the booking; logs only.
  if (appointmentId) {
    try {
      await pushBookingToCrm({
        supabase,
        shopId: claimed.shop_id,
        appointmentId,
        customerId: customerResult.customer.id,
        customerName: proposal.customer_name,
        phone: proposal.phone || null,
        email: proposal.email ?? null,
        service: proposal.service,
        isoStartTime: start.toISOString(),
        carInfo: proposal.car_info,
      })
    } catch (err) {
      console.warn("[approvals] CRM booking push failed:", err)
    }
  }

  // Fan out booking_approved to any enabled event-driven custom agents
  // (e.g., the prep-email recipe). Best-effort — never blocks the
  // approval flow.
  try {
    await dispatchAgentEvent(
      {
        kind: "booking_approved",
        shopId: claimed.shop_id,
        customerName: proposal.customer_name,
        customerEmail: proposal.email,
        customerPhone: proposal.phone || null,
        customerId: customerResult.customer.id,
        serviceName: proposal.service,
        isoStartTime: start.toISOString(),
        timezone: proposal.timezone,
        appointmentId,
      },
      supabase
    )
  } catch (err) {
    console.warn("[approvals] booking_approved dispatch failed:", err)
  }

  return {
    ok: true,
    status: "executed",
    actionType: "book_appointment",
    resultId: leadId ?? appointmentId,
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

export type QuoteProposal = {
  customer_name: string
  phone: string
  car_info: string | null
  /** Service names heard on the call, matched against the menu on approve. */
  services: string[]
  notes: string | null
}

/**
 * create_quote executor (ALWAYS_HITL — runs only on human approve, C3).
 * Creates a DRAFT quote priced through lib/service-pricing at approve time
 * (so a menu edit between call and approve prices correctly). NEVER sends —
 * sending is a separate explicit owner action from the quote surface.
 */
async function executeCreateQuote(
  supabase: SupabaseClient,
  claimed: ClaimedAction
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as QuoteProposal
  if (!proposal.customer_name?.trim() || !proposal.phone?.trim()) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: "Quote proposal is missing the customer." }
  }

  const customerResult = await findOrCreateCustomer(supabase, claimed.shop_id, {
    name: proposal.customer_name,
    phone: proposal.phone,
  })
  if (!customerResult.ok) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: `Customer resolution failed: ${customerResult.error}` }
  }

  const vehicle = parseVehicle(proposal.car_info)
  const vehicleId = await upsertCustomerVehicle(
    supabase,
    claimed.shop_id,
    customerResult.customer.id,
    vehicle
  )
  const vehicles = await vehiclesByCustomerIds(supabase, claimed.shop_id, [
    customerResult.customer.id,
  ])
  const sizeClass =
    vehicles
      .get(customerResult.customer.id)
      ?.find((v) => v.id === vehicleId)?.size_class ?? null

  const { data: svcData } = await supabase
    .from("services")
    .select("*")
    .eq("shop_id", claimed.shop_id)
  const menu = (svcData as ServiceRow[] | null) ?? []
  const wanted = (proposal.services ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const matched = menu.filter((s) =>
    wanted.some(
      (w) => s.name.toLowerCase() === w || s.name.toLowerCase().includes(w)
    )
  )

  const lineItems = matched.map((s) => buildQuoteLineItem(s, sizeClass))
  const totals = computeQuoteTotals(lineItems)

  const { data: quote, error: quoteErr } = await supabase
    .from("quotes")
    .insert({
      shop_id: claimed.shop_id,
      customer_id: customerResult.customer.id,
      vehicle_id: vehicleId,
      status: "draft", // locked: agent quotes are ALWAYS draft
      line_items: lineItems,
      ...totals,
      internal_note:
        [
          proposal.notes,
          wanted.length > matched.length
            ? `Unmatched services from the call: ${proposal.services.join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join(" — ") || null,
      created_by: "agent",
    })
    .select("id")
    .single()

  if (quoteErr || !quote) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: quoteErr?.message ?? "Quote insert failed (is the C1 migration applied?)",
    }
  }

  await supabase
    .from("pending_actions")
    .update({ result_id: (quote as { id: string }).id })
    .eq("id", claimed.id)

  await recordInteraction(supabase, {
    shopId: claimed.shop_id,
    customerId: customerResult.customer.id,
    channel: "note",
    role: "system",
    content: `Draft quote created from a call — ${lineItems.length} item${lineItems.length === 1 ? "" : "s"}.`,
    metadata: {
      kind: "quote",
      quote_id: (quote as { id: string }).id,
      event: "drafted",
      source: "voice",
    },
  })

  return {
    ok: true,
    status: "executed",
    actionType: "create_quote",
    resultId: (quote as { id: string }).id,
    proposal: proposal as unknown as Record<string, unknown>,
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

  // A2P gate — a Gradia-provisioned number can't text until carriers
  // approve its campaign. Enforced here at the send boundary, in code.
  const smsGate = smsGateForShop(shop, shop.twilio_phone_number)
  if (!smsGate.allowed) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: smsGate.reason }
  }

  // Safe-send policy (B2): quiet hours + opt-out + marketing consent. A held
  // send is rolled back to staged so it can go out in-window later.
  const policy = await evaluateSmsSendPolicy(supabase, shop, {
    toPhone: proposal.to_phone,
    customerId: proposal.customer_id ?? null,
    category: proposal.category ?? "transactional",
  })
  if (!policy.allowed) {
    await rollbackClaim(supabase, claimed.id)
    return { ok: false, error: policy.reason }
  }

  let sendResult
  try {
    sendResult = await sendOutboundSms({
      from: shop.twilio_phone_number,
      to: proposal.to_phone,
      body: proposal.body,
      statusCallback: defaultStatusCallbackUrl(claimed.shop_id),
      creds: resolveTwilioCredentials(shop),
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

  // Locked menu: 4 credits per SMS segment, metered on send.
  {
    const segments = smsSegments(proposal.body)
    const priced = priceUsage(await getPricing(supabase), "sms_segment", segments)
    await recordUsage(supabase, claimed.shop_id, "sms_segment", {
      quantity: segments,
      credits: priced.credits,
      wholesaleCost: priced.wholesale_cost,
      retailCost: priced.retail_cost,
      vendorRef: sendResult.messageSid,
      refId: claimed.id,
    })
  }

  return {
    ok: true,
    status: "executed",
    actionType: "send_sms",
    resultId,
    proposal,
    messageSid: sendResult.messageSid,
  }
}

async function executeSendEmail(
  supabase: SupabaseClient,
  claimed: ClaimedAction
): Promise<ApprovalResult> {
  const proposal = claimed.payload as unknown as EmailProposal

  if (
    !proposal.to_email?.trim() ||
    !proposal.subject?.trim() ||
    !proposal.body?.trim()
  ) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: "Email needs a recipient, subject, and body.",
    }
  }

  const shop = await loadShopWithToken(supabase, claimed.shop_id)
  let accessToken: string | null = null
  if (shop) {
    try {
      accessToken = await getAurinkoAccessTokenForShop(supabase, shop)
    } catch (err) {
      console.warn("[approvals] Aurinko token refresh failed:", err)
    }
  }
  if (!shop || !accessToken) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error: "Connect Gmail via Aurinko (in /settings) before approving emails.",
    }
  }

  let sentId: string
  try {
    const sent = await sendEmailMessage(accessToken, {
      subject: proposal.subject,
      body: proposal.body,
      to: proposal.to_email,
    })
    sentId = sent.id
  } catch (err) {
    await rollbackClaim(supabase, claimed.id)
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Aurinko: ${err.message}`
          : "Email send failed.",
    }
  }

  let customerId = proposal.customer_id
  if (!customerId) {
    const customer = await findCustomerByChannel(supabase, claimed.shop_id, {
      email: proposal.to_email,
    })
    if (customer) customerId = customer.id
  }

  const interaction = await recordInteraction(supabase, {
    shopId: claimed.shop_id,
    customerId,
    channel: "email",
    role: "gradia",
    content: `Subject: ${proposal.subject}\n\n${proposal.body}`,
    metadata: {
      direction: "outbound",
      aurinko_message_id: sentId || null,
      to_email: proposal.to_email,
      subject: proposal.subject,
      pending_action_id: claimed.id,
      reason: proposal.reason ?? null,
    },
  })

  const resultId = interaction.ok ? interaction.id : sentId

  await supabase
    .from("pending_actions")
    .update({ result_id: resultId })
    .eq("id", claimed.id)

  // Locked menu: 1 credit per email send.
  {
    const priced = priceUsage(await getPricing(supabase), "email_send", 1)
    await recordUsage(supabase, claimed.shop_id, "email_send", {
      credits: priced.credits,
      wholesaleCost: priced.wholesale_cost,
      retailCost: priced.retail_cost,
      refId: claimed.id,
    })
  }

  return {
    ok: true,
    status: "executed",
    actionType: "send_email",
    resultId,
    proposal,
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
    case "reschedule_appointment":
      return {
        ok: true,
        status: "claimed",
        actionType: "reschedule_appointment",
        proposal: claimed.payload as unknown as Record<string, unknown>,
      }
    case "cancel_appointment":
      return {
        ok: true,
        status: "claimed",
        actionType: "cancel_appointment",
        proposal: claimed.payload as unknown as Record<string, unknown>,
      }
    case "send_email":
      return {
        ok: true,
        status: "claimed",
        actionType: "send_email",
        proposal: claimed.payload as unknown as EmailProposal,
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
