"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  recordApprovalResolution,
  type ApprovalResolution,
} from "@/lib/trust"

import {
  executeApproval,
  executeRejection,
  type ApprovalResult,
  type DecisionResult,
} from "@/lib/approvals"
import {
  stagingAvailability,
  type AvailabilitySummary,
  type ConflictOverride,
} from "@/lib/availability"
import { requireShop, requireUser } from "@/lib/shop"
import { dashboardDecidedBlocks, updateSlackForPending } from "@/lib/slack"
import { createClient } from "@/lib/supabase/server"
import type { LeadStatus, PendingActionRow } from "@/lib/types/database"

export type DashboardDecisionResult =
  | { ok: true; alreadyDecided: boolean }
  | { ok: false; error: string }

export async function approveFromDashboard(
  pendingId: string,
  resolution: ApprovalResolution = "approved_unedited"
): Promise<DashboardDecisionResult> {
  const user = await requireUser()
  // P0-011 (C-2): the claim is tenant-bound — the session-resolved shop is
  // the authorized tenant (RLS already limits the session client; the
  // explicit id makes the binding mechanism, not policy).
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await executeApproval(supabase, pendingId, shop.id, {
    userId: user.id,
  })

  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  // Earned-autonomy signal: approved unedited vs after an edit.
  void recordApprovalResolution(supabase, pendingId, resolution)

  // Best-effort Slack card refresh — never block the dashboard
  // response on it.
  if (result.status === "executed") {
    void notifySlackApproved(pendingId, user.email ?? null, result)
  }

  revalidatePath("/dashboard")
  revalidatePath("/customers")
  revalidatePath("/approvals")
  return { ok: true, alreadyDecided: result.status === "already_decided" }
}

/**
 * P0-004 / D-016 — "Book it anyway". Records a ConflictOverride on the
 * payload (actor + timestamp stamped server-side, reason required, conflict
 * keys from a FRESH availability check) and then runs the normal approval
 * engine. The executor re-validates: if the schedule changed and new
 * conflicts appeared that this override doesn't cover, execution refuses
 * and the card returns to pending with refreshed conflict info.
 */
export async function approveWithConflictOverride(
  pendingId: string,
  reason: string
): Promise<DashboardDecisionResult> {
  const trimmed = reason.trim()
  if (!trimmed) {
    return { ok: false, error: "Give a short reason — it's recorded with the override." }
  }
  const user = await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("pending_actions")
    .select("*")
    .eq("id", pendingId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  const pending = data as PendingActionRow | null
  if (!pending) return { ok: false, error: "Couldn't find that pending action." }
  if (
    pending.action_type !== "book_appointment" &&
    pending.action_type !== "reschedule_appointment"
  ) {
    return { ok: false, error: "Only calendar actions can be conflict-overridden." }
  }
  if (pending.status !== "pending" && pending.status !== "edit_requested") {
    return { ok: true, alreadyDecided: true }
  }

  // Fresh conflict keys — the override records what the owner saw NOW, not
  // whatever was on the card when it was staged.
  const payload = pending.payload as Record<string, unknown>
  const isoStart =
    pending.action_type === "book_appointment"
      ? (payload.iso_start_time as string | undefined)
      : ((payload.iso_new_start_time as string | undefined) ?? undefined)
  const startMs = isoStart ? Date.parse(isoStart) : Number.NaN
  if (Number.isNaN(startMs)) {
    return { ok: false, error: "This card has no exact time — edit one in before overriding." }
  }
  const durationMinutes =
    typeof payload.duration_minutes === "number" && payload.duration_minutes > 0
      ? payload.duration_minutes
      : 90
  const fresh = await stagingAvailability(supabase, shop.id, {
    start: new Date(startMs),
    end: new Date(startMs + durationMinutes * 60_000),
    excludeAppointmentId:
      pending.action_type === "reschedule_appointment"
        ? ((payload.appointment_id as string | null) ?? null)
        : null,
    path: "override:approvals",
  })
  // Internal check failure → no override is offered (founder policy): an
  // override covers conflicts the owner SAW, and a failed check saw nothing.
  // The executor would refuse anyway; refusing here keeps the card pending
  // without recording a conflict_override that covers an empty list.
  if (fresh.failure) {
    return {
      ok: false,
      error:
        "Couldn't verify the schedule just now, so overriding isn't available — nothing was booked. Try again in a moment.",
    }
  }
  const summary: AvailabilitySummary | null = fresh.summary
  const override: ConflictOverride = {
    by: user.id,
    at: new Date().toISOString(),
    reason: trimmed,
    conflicts: summary
      ? summary.conflicts
          .filter((c) => c.severity === "blocking")
          .map((c) => c.key)
      : [],
  }

  const { error: writeErr } = await supabase
    .from("pending_actions")
    .update({
      payload: {
        ...payload,
        ...(summary ? { availability: summary } : {}),
        conflict_override: override,
      },
    })
    .eq("id", pendingId)
    .eq("shop_id", shop.id)
    .in("status", ["pending", "edit_requested"])
  if (writeErr) return { ok: false, error: writeErr.message }

  return approveFromDashboard(pendingId, "approved_unedited")
}

export async function rejectFromDashboard(
  pendingId: string
): Promise<DashboardDecisionResult> {
  const user = await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const result = await executeRejection(supabase, pendingId, shop.id, {
    userId: user.id,
  })

  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  void recordApprovalResolution(supabase, pendingId, "rejected")

  if (result.status === "claimed") {
    void notifySlackRejected(pendingId, user.email ?? null, result)
  }

  revalidatePath("/approvals")
  return { ok: true, alreadyDecided: result.status === "already_decided" }
}

/**
 * Undo for "Drop it" (L3 — every reversible mutation gets an undo).
 * A rejection has no side effects, so restoring it just re-stages the
 * HITL card: status back to pending, decision fields cleared. Only a
 * currently-rejected row owned by the caller's shop qualifies — approve
 * is never undoable (it executed a real send).
 */
export async function undoRejectFromDashboard(
  pendingId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const shop = await requireShop()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("pending_actions")
    .update({
      status: "pending",
      decided_at: null,
      decided_by_slack: null,
      decided_by_user: null,
      resolution: null,
    })
    .eq("id", pendingId)
    .eq("shop_id", shop.id)
    .eq("status", "rejected")
    .select("id")
    .maybeSingle()

  if (error) {
    return { ok: false, error: error.message }
  }
  if (!data) {
    return { ok: false, error: "That one can't be restored." }
  }

  revalidatePath("/approvals")
  return { ok: true }
}

async function notifySlackApproved(
  pendingId: string,
  approverEmail: string | null,
  result: Extract<ApprovalResult, { ok: true }>
): Promise<void> {
  if (result.status !== "executed") return
  try {
    await updateSlackForPending({
      pendingActionId: pendingId,
      text: `Approved · ${approvedSummary(result)}`,
      blocks: dashboardDecidedBlocks({
        headline: approvedHeadline(result),
        summary: approvedSummary(result),
        approverEmail,
      }),
    })
  } catch (err) {
    console.warn("[approvals] Slack update on approve failed:", err)
  }
}

async function notifySlackRejected(
  pendingId: string,
  approverEmail: string | null,
  result: Extract<DecisionResult, { ok: true }>
): Promise<void> {
  if (result.status !== "claimed") return
  try {
    await updateSlackForPending({
      pendingActionId: pendingId,
      text: `Dropped · ${rejectedSummary(result)}`,
      blocks: dashboardDecidedBlocks({
        headline: "Dropped",
        summary: rejectedSummary(result),
        approverEmail,
      }),
    })
  } catch (err) {
    console.warn("[approvals] Slack update on reject failed:", err)
  }
}

function approvedHeadline(
  result: Extract<ApprovalResult, { ok: true; status: "executed" }>
): string {
  switch (result.actionType) {
    case "create_lead":
      return "Lead approved"
    case "add_note":
      return "Note saved"
    case "book_appointment":
      return "Booking confirmed"
    case "reschedule_appointment":
      return "Booking moved"
    case "cancel_appointment":
      return "Booking cancelled"
    case "send_sms":
      return "SMS sent"
    case "send_email":
      return "Email sent"
    case "create_quote":
      return "Draft quote created"
  }
}

function approvedSummary(
  result: Extract<ApprovalResult, { ok: true; status: "executed" }>
): string {
  switch (result.actionType) {
    case "create_lead":
      return result.proposal.customer_name || "new lead"
    case "add_note":
      return (
        result.proposal.customer_name?.trim() ||
        result.proposal.content.slice(0, 60)
      )
    case "book_appointment":
      return `${result.proposal.customer_name} · ${result.proposal.iso_start_time}`
    case "reschedule_appointment":
      return `${(result.proposal.customer_name as string | null) ?? "booking"} → ${(result.proposal.new_when as string | null) ?? "new time"}`
    case "cancel_appointment":
      return `${(result.proposal.customer_name as string | null) ?? "booking"} cancelled`
    case "send_sms":
      return `${result.proposal.customer_name ?? result.proposal.to_phone}`
    case "send_email":
      return `${result.proposal.customer_name ?? result.proposal.to_email}`
    case "create_quote":
      return `${(result.proposal.customer_name as string | null) ?? "customer"} — draft in Quotes`
  }
}

function rejectedSummary(
  result: Extract<DecisionResult, { ok: true; status: "claimed" }>
): string {
  switch (result.actionType) {
    case "create_lead":
      return result.proposal.customer_name || "lead proposal"
    case "add_note":
      return "note"
    case "book_appointment":
      return `booking for ${result.proposal.customer_name}`
    case "reschedule_appointment":
      return "reschedule request"
    case "cancel_appointment":
      return "cancellation request"
    case "send_sms":
      return `SMS to ${result.proposal.customer_name ?? result.proposal.to_phone}`
    case "send_email":
      return `email to ${result.proposal.customer_name ?? result.proposal.to_email}`
    case "create_quote":
      return `draft quote for ${(result.proposal.customer_name as string | null) ?? "customer"}`
  }
}

// ---------- Edit / save-and-approve ----------

const leadPatchSchema = z.object({
  type: z.literal("create_lead"),
  customer_name: z.string().trim().min(1, "Customer name is required").max(200),
  phone: z.string().trim().max(60),
  car_info: z.string().trim().max(200).nullable(),
  pin_notes: z.string().trim().max(2000).nullable(),
  status: z.enum(["new", "quoted", "booked"]) satisfies z.ZodType<LeadStatus>,
})

const notePatchSchema = z.object({
  type: z.literal("add_note"),
  content: z.string().trim().min(1, "Note can't be empty").max(4000),
  customer_name: z.string().trim().max(200).nullable(),
  phone: z.string().trim().max(60).nullable(),
})

const bookingPatchSchema = z.object({
  type: z.literal("book_appointment"),
  customer_name: z.string().trim().min(1, "Customer name is required").max(200),
  phone: z.string().trim().max(60),
  car_info: z.string().trim().max(200).nullable(),
  service: z.string().trim().max(200).nullable(),
  iso_start_time: z
    .string()
    .trim()
    .refine(
      (v) => !Number.isNaN(new Date(v).getTime()),
      "Pick a valid date and time."
    ),
  duration_minutes: z.number().int().positive().max(24 * 60),
  timezone: z.string().trim().max(80).nullable(),
  pin_notes: z.string().trim().max(2000).nullable(),
})

const smsPatchSchema = z.object({
  type: z.literal("send_sms"),
  to_phone: z
    .string()
    .trim()
    .refine(
      (v) => /^\+\d{8,15}$/.test(v),
      "Recipient must be in E.164 format."
    ),
  body: z.string().trim().min(1, "Message can't be empty.").max(1600),
  customer_name: z.string().trim().max(200).nullable(),
  reason: z.string().trim().max(200).nullable(),
})

const emailPatchSchema = z.object({
  type: z.literal("send_email"),
  to_email: z.string().trim().email("Recipient must be a valid email."),
  subject: z.string().trim().min(1, "Subject can't be empty.").max(200),
  body: z.string().trim().min(1, "Body can't be empty.").max(8_000),
  customer_name: z.string().trim().max(200).nullable(),
  reason: z.string().trim().max(200).nullable(),
})

const patchSchema = z.discriminatedUnion("type", [
  leadPatchSchema,
  notePatchSchema,
  bookingPatchSchema,
  smsPatchSchema,
  emailPatchSchema,
])

export type ProposalPatch = z.infer<typeof patchSchema>

export type UpdateProposalResult =
  | { ok: true; alreadyDecided: false; pending: PendingActionRow }
  | { ok: true; alreadyDecided: true }
  | { ok: false; error: string }

/**
 * Merges the editor's patch onto the existing payload (preserving
 * source-specific extras like vapi_call_id / aurinko_message_id /
 * transcript) and writes it back. The action stays in pending /
 * edit_requested status — approval is a separate step so the editor
 * can offer "Save" and "Save & approve" independently.
 */
export async function updatePendingProposal(
  pendingId: string,
  patch: ProposalPatch
): Promise<UpdateProposalResult> {
  const parsed = patchSchema.safeParse(patch)
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "Please check the form and try again.",
    }
  }

  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()

  const { data: existing, error: fetchErr } = await supabase
    .from("pending_actions")
    .select("*")
    .eq("id", pendingId)
    .eq("shop_id", shop.id)
    .maybeSingle()

  if (fetchErr) {
    return { ok: false, error: fetchErr.message }
  }
  if (!existing) {
    return { ok: false, error: "Couldn't find that pending action." }
  }
  const current = existing as PendingActionRow
  if (current.action_type !== parsed.data.type) {
    return { ok: false, error: "Edit type doesn't match the pending action." }
  }
  if (current.status !== "pending" && current.status !== "edit_requested") {
    return { ok: true, alreadyDecided: true }
  }

  const mergedPayload =
    parsed.data.type === "create_lead"
      ? {
          ...current.payload,
          customer_name: parsed.data.customer_name,
          phone: parsed.data.phone,
          car_info: parsed.data.car_info,
          pin_notes: parsed.data.pin_notes,
          status: parsed.data.status,
        }
      : parsed.data.type === "book_appointment"
        ? {
            ...current.payload,
            customer_name: parsed.data.customer_name,
            phone: parsed.data.phone,
            car_info: parsed.data.car_info,
            service: parsed.data.service,
            iso_start_time: new Date(parsed.data.iso_start_time).toISOString(),
            duration_minutes: parsed.data.duration_minutes,
            timezone: parsed.data.timezone,
            pin_notes: parsed.data.pin_notes,
          }
        : parsed.data.type === "send_sms"
          ? {
              ...current.payload,
              to_phone: parsed.data.to_phone,
              body: parsed.data.body,
              customer_name: parsed.data.customer_name,
              reason: parsed.data.reason,
            }
          : parsed.data.type === "send_email"
            ? {
                ...current.payload,
                to_email: parsed.data.to_email,
                subject: parsed.data.subject,
                body: parsed.data.body,
                customer_name: parsed.data.customer_name,
                reason: parsed.data.reason,
              }
            : {
                ...current.payload,
                content: parsed.data.content,
                customer_name: parsed.data.customer_name,
                phone: parsed.data.phone,
              }

  // P0-004: an edited booking time invalidates the staged conflict snapshot
  // and any override recorded against the OLD conflicts — drop both rather
  // than show stale warnings. The executor re-checks at approve time.
  if (parsed.data.type === "book_appointment") {
    delete (mergedPayload as Record<string, unknown>).availability
    delete (mergedPayload as Record<string, unknown>).conflict_override
  }

  const { data: updated, error: updateErr } = await supabase
    .from("pending_actions")
    .update({ payload: mergedPayload })
    .eq("id", pendingId)
    .eq("shop_id", shop.id)
    .select("*")
    .single()

  if (updateErr || !updated) {
    return { ok: false, error: updateErr?.message ?? "Couldn't save changes." }
  }

  revalidatePath("/approvals")
  revalidatePath(`/approvals/${pendingId}`)
  return { ok: true, alreadyDecided: false, pending: updated as PendingActionRow }
}

export type ApproveWithEditsResult =
  | { ok: true; alreadyDecided: boolean }
  | { ok: false; error: string }

/**
 * Persists the edited payload, then runs the standard approval engine.
 * Atomically: the engine's claim still gates against concurrent decisions
 * elsewhere (Slack, /approvals).
 */
export async function approveWithEdits(
  pendingId: string,
  patch: ProposalPatch
): Promise<ApproveWithEditsResult> {
  const updateResult = await updatePendingProposal(pendingId, patch)
  if (!updateResult.ok) {
    return { ok: false, error: updateResult.error }
  }
  if (updateResult.alreadyDecided) {
    return { ok: true, alreadyDecided: true }
  }

  return approveFromDashboard(pendingId, "approved_edited")
}
