"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { executeApproval, executeRejection } from "@/lib/approvals"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { LeadStatus, PendingActionRow } from "@/lib/types/database"

export type DashboardDecisionResult =
  | { ok: true; alreadyDecided: boolean }
  | { ok: false; error: string }

export async function approveFromDashboard(
  pendingId: string
): Promise<DashboardDecisionResult> {
  const user = await requireUser()
  const supabase = await createClient()
  const result = await executeApproval(supabase, pendingId, { userId: user.id })

  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  revalidatePath("/dashboard")
  revalidatePath("/leads")
  revalidatePath("/approvals")
  return { ok: true, alreadyDecided: result.status === "already_decided" }
}

export async function rejectFromDashboard(
  pendingId: string
): Promise<DashboardDecisionResult> {
  const user = await requireUser()
  const supabase = await createClient()
  const result = await executeRejection(supabase, pendingId, { userId: user.id })

  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  revalidatePath("/approvals")
  return { ok: true, alreadyDecided: result.status === "already_decided" }
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

const chargePatchSchema = z.object({
  type: z.literal("charge_customer"),
  customer_name: z.string().trim().min(1, "Customer name is required.").max(200),
  customer_email: z
    .string()
    .trim()
    .email("Use a valid email so Stripe can deliver the invoice."),
  amount_cents: z.number().int().positive().max(10_000_000),
  description: z.string().trim().min(1, "Tell us what they're paying for.").max(500),
})

const emailPatchSchema = z.object({
  type: z.literal("send_email"),
  to_email: z.string().trim().email("Recipient must be a valid email."),
  subject: z.string().trim().min(1, "Subject can't be empty.").max(200),
  body: z.string().trim().min(1, "Body can't be empty.").max(8_000),
  customer_name: z.string().trim().max(200).nullable(),
  reason: z.string().trim().max(200).nullable(),
})

const instagramDmPatchSchema = z.object({
  type: z.literal("send_instagram_dm"),
  recipient_id: z
    .string()
    .trim()
    .min(1, "Recipient ID is required.")
    .max(120),
  body: z.string().trim().min(1, "Message can't be empty.").max(900),
  customer_name: z.string().trim().max(200).nullable(),
  reason: z.string().trim().max(200).nullable(),
})

const patchSchema = z.discriminatedUnion("type", [
  leadPatchSchema,
  notePatchSchema,
  bookingPatchSchema,
  smsPatchSchema,
  chargePatchSchema,
  emailPatchSchema,
  instagramDmPatchSchema,
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
          : parsed.data.type === "charge_customer"
            ? {
                ...current.payload,
                customer_name: parsed.data.customer_name,
                customer_email: parsed.data.customer_email,
                amount_cents: parsed.data.amount_cents,
                description: parsed.data.description,
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
              : parsed.data.type === "send_instagram_dm"
                ? {
                    ...current.payload,
                    recipient_id: parsed.data.recipient_id,
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

  return approveFromDashboard(pendingId)
}
