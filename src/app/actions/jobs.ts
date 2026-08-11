"use server"

import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  getAccessTokenForShop as getAurinkoAccessTokenForShop,
  updateCalendarEventTime,
} from "@/lib/aurinko"
import {
  emitConflictEvent,
  stagingAvailability,
  type AvailabilitySummary,
} from "@/lib/availability"
import { advanceJobStatus } from "@/lib/jobs"
import { recordInteraction } from "@/lib/memory"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import type {
  AppointmentRow,
  JobHoldReason,
  JobPaymentStatus,
  JobStatus,
} from "@/lib/types/database"

/**
 * Job actions (CRM C4a/C4b). Status taps and drags are OWNER actions —
 * free, immediate — but anything that would TEXT the customer (a reschedule
 * heads-up) stages a pending approval like every outbound. No new send path.
 *
 * P0-004: moving or blocking time is owner-direct HITL (D-016) — a blocking
 * conflict returns `conflict` so the UI can warn; the retry carries an
 * override reason, and the override is recorded with actor + timestamp.
 */

export type JobConflictInfo = {
  labels: string[]
  keys: string[]
  /** True when the availability check itself failed — never claimed clear. */
  unverified: boolean
}

export type JobActionResult =
  | { ok: true }
  | { ok: false; error: string; conflict?: JobConflictInfo }

export type JobOverrideOptions = {
  /** Non-empty reason = the owner saw the warning and chose to proceed. */
  overrideReason?: string
}

/** Owner-direct conflict gate shared by rescheduleJob and blockTime. */
async function ownerConflictGate(input: {
  supabase: Awaited<ReturnType<typeof createClient>>
  shopId: string
  userId: string
  start: Date
  end: Date
  excludeAppointmentId?: string | null
  path: string
  overrideReason?: string
  verb: string
}): Promise<
  | { proceed: true; overridden: boolean; summary: AvailabilitySummary | null }
  | { proceed: false; result: JobActionResult }
> {
  const { summary, blocking, failure } = await stagingAvailability(
    input.supabase,
    input.shopId,
    {
      start: input.start,
      end: input.end,
      excludeAppointmentId: input.excludeAppointmentId ?? null,
      path: input.path,
    }
  )
  // Internal check failure fails CLOSED (founder policy): this path EXECUTES
  // the calendar write directly, so an unverified schedule refuses the write
  // for both plain and override retries — an override reason cannot bypass a
  // failure (there is no conflict list to override). Checked before the
  // conflict branch so the guard wins over any overrideReason.
  if (failure) {
    return {
      proceed: false,
      result: {
        ok: false,
        error:
          "Couldn't verify the schedule — Gradia's availability data wasn't readable, so nothing was changed. Try again in a moment.",
        conflict: { labels: [], keys: [], unverified: true },
      },
    }
  }
  if (blocking.length === 0) {
    return { proceed: true, overridden: false, summary }
  }
  const reason = input.overrideReason?.trim()
  if (!reason) {
    return {
      proceed: false,
      result: {
        ok: false,
        error: `That time conflicts with ${blocking[0].label}`,
        conflict: {
          labels: blocking.map((b) => b.label),
          keys: summary
            ? summary.conflicts
                .filter((c) => c.severity === "blocking")
                .map((c) => c.key)
            : [],
          unverified: Boolean(summary?.error),
        },
      },
    }
  }
  const keys = summary
    ? summary.conflicts
        .filter((c) => c.severity === "blocking")
        .map((c) => c.key)
    : []
  emitConflictEvent("booking_conflict_overridden", {
    shopId: input.shopId,
    path: input.path,
    conflictKeys: keys,
  })
  // Audit evidence (D-016) — the override rides the interaction log since
  // owner-direct moves have no pending_action to carry it.
  await recordInteraction(input.supabase, {
    shopId: input.shopId,
    customerId: null,
    channel: "note",
    role: "system",
    content: `${input.verb} despite a schedule conflict — owner override. Reason: ${reason}.`,
    metadata: {
      kind: "conflict_override",
      overridden_by: input.userId,
      overridden_at: new Date().toISOString(),
      reason,
      conflicts: keys,
      conflict_labels: blocking.map((b) => b.label),
      path: input.path,
    },
  })
  return { proceed: true, overridden: true, summary }
}

export async function setJobStatus(
  jobId: string,
  status: JobStatus,
  holdReason?: JobHoldReason | null
): Promise<JobActionResult> {
  const shop = await requireShop()
  await requireUser()
  const supabase = await createClient()
  const result = await advanceJobStatus(supabase, shop.id, jobId, status, {
    holdReason: holdReason ?? null,
  })
  if (!result.ok) return result
  revalidatePath("/calendar")
  return { ok: true }
}

/** Manual payment toggle (P9 rule: no new payment features — a field, not a flow). */
export async function setJobPaymentStatus(
  jobId: string,
  paymentStatus: JobPaymentStatus
): Promise<JobActionResult> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { error } = await supabase
    .from("appointments")
    .update({ payment_status: paymentStatus, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("shop_id", shop.id)
  if (error) {
    return { ok: false, error: `Couldn't save that (is the C1 migration applied?)` }
  }
  revalidatePath("/calendar")
  return { ok: true }
}

const logisticsSchema = z.object({
  bay: z.string().trim().max(20).optional(),
  keyTag: z.string().trim().max(40).optional(),
  travelFeeDollars: z.number().min(0).max(100_000).nullable().optional(),
  water: z.boolean().optional(),
  power: z.boolean().optional(),
  gate: z.string().trim().max(120).optional(),
  parking: z.string().trim().max(120).optional(),
  weatherFlag: z.boolean().optional(),
  internalNote: z.string().trim().max(2000).optional(),
})

/** Shop/mobile logistics in one patch. Bay lives in access_notes.bay. */
export async function updateJobLogistics(
  jobId: string,
  input: z.infer<typeof logisticsSchema>
): Promise<JobActionResult> {
  const parsed = logisticsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." }
  }
  const shop = await requireShop()
  const supabase = await createClient()

  const { data } = await supabase
    .from("appointments")
    .select("access_notes")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const existingNotes =
    ((data as { access_notes?: Record<string, unknown> | null } | null)?.access_notes ??
      {}) as Record<string, unknown>

  const d = parsed.data
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const notes = { ...existingNotes }
  if (d.bay !== undefined) notes.bay = d.bay || null
  if (d.water !== undefined) notes.water = d.water
  if (d.power !== undefined) notes.power = d.power
  if (d.gate !== undefined) notes.gate = d.gate || null
  if (d.parking !== undefined) notes.parking = d.parking || null
  patch.access_notes = notes
  if (d.keyTag !== undefined) patch.key_tag = d.keyTag || null
  if (d.travelFeeDollars !== undefined) {
    patch.travel_fee_cents =
      d.travelFeeDollars == null ? null : Math.round(d.travelFeeDollars * 100)
  }
  if (d.weatherFlag !== undefined) patch.weather_flag = d.weatherFlag
  if (d.internalNote !== undefined) patch.internal_note = d.internalNote || null

  const { error } = await supabase
    .from("appointments")
    .update(patch)
    .eq("id", jobId)
    .eq("shop_id", shop.id)
  if (error) {
    return { ok: false, error: "Couldn't save that (is the C1 migration applied?)" }
  }
  revalidatePath("/calendar")
  return { ok: true }
}

/**
 * Drag-to-reschedule. The MOVE is the owner's direct action (their own
 * calendar); the customer HEADS-UP stages as a send_sms approval — customer-
 * facing reschedule notifications are HITL per the rail.
 */
export async function rescheduleJob(
  jobId: string,
  newStartIso: string,
  options?: JobOverrideOptions
): Promise<JobActionResult & { notificationStaged?: boolean }> {
  const newStart = new Date(newStartIso)
  if (Number.isNaN(newStart.getTime())) {
    return { ok: false, error: "That time didn't parse." }
  }
  const shop = await requireShop()
  const user = await requireUser()
  const supabase = await createClient()

  const { data } = await supabase
    .from("appointments")
    .select("*, customer:customers(id, name, phone)")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const job = data as
    | (AppointmentRow & { customer: { id: string; name: string | null; phone: string | null } | null })
    | null
  if (!job) return { ok: false, error: "Job not found." }

  const durationMs = (job.duration_minutes ?? 90) * 60_000

  // P0-004: warn-confirm on conflict (owner-direct HITL, D-016). The moving
  // job excludes itself so dropping it back near its own slot never warns.
  const gate = await ownerConflictGate({
    supabase,
    shopId: shop.id,
    userId: user.id,
    start: newStart,
    end: new Date(newStart.getTime() + durationMs),
    excludeAppointmentId: jobId,
    path: "owner:drag_reschedule",
    overrideReason: options?.overrideReason,
    verb: `Moved ${job.service_name ?? "a job"} to ${newStart.toISOString()}`,
  })
  if (!gate.proceed) return gate.result

  const { error } = await supabase
    .from("appointments")
    .update({
      scheduled_at: newStart.toISOString(),
      ends_at: new Date(newStart.getTime() + durationMs).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("shop_id", shop.id)
  if (error) return { ok: false, error: error.message }

  // Keep the linked calendar event in step (best-effort — owner's own move).
  if (job.aurinko_event_id) {
    try {
      const { data: shopRow } = await supabase
        .from("shops")
        .select("id, aurinko_account_id, aurinko_access_token_enc, aurinko_token_expires_at")
        .eq("id", shop.id)
        .maybeSingle()
      const token = shopRow
        ? await getAurinkoAccessTokenForShop(
            supabase,
            shopRow as Parameters<typeof getAurinkoAccessTokenForShop>[1]
          )
        : null
      if (token) {
        await updateCalendarEventTime(token, job.aurinko_calendar_id ?? "primary", job.aurinko_event_id, {
          startIso: newStart.toISOString(),
          endIso: new Date(newStart.getTime() + durationMs).toISOString(),
          timezone: job.timezone ?? "UTC",
        })
      }
    } catch (err) {
      console.warn("[jobs] calendar event move failed (job still moved):", err)
    }
  }

  await recordInteraction(supabase, {
    shopId: shop.id,
    customerId: job.customer_id,
    channel: "note",
    role: "system",
    content: `Job rescheduled to ${newStart.toLocaleString()}.`,
    metadata: { kind: "job_reschedule", appointment_id: jobId, new_start: newStart.toISOString() },
  })

  // Customer heads-up: staged, never auto-sent (calendar-adjacent outbound).
  let notificationStaged = false
  if (job.customer?.phone && newStart.getTime() > Date.now()) {
    const when = newStart.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    const first = job.customer.name?.trim().split(/\s+/)[0]
    const { error: stageErr } = await supabase.from("pending_actions").insert({
      shop_id: shop.id,
      action_type: "send_sms",
      payload: {
        to_phone: job.customer.phone,
        body: `Hi ${first || "there"}, it's ${shop.name} — we've moved your${job.service_name ? ` ${job.service_name}` : ""} appointment to ${when}. Reply if that doesn't work and we'll find a better slot. — ${shop.name}`,
        customer_name: job.customer.name,
        customer_id: job.customer.id,
        reason: "Reschedule heads-up",
        source: "job_reschedule",
        appointment_id: jobId,
      },
      requested_by: user.id,
    })
    notificationStaged = !stageErr
  }

  revalidatePath("/calendar")
  return { ok: true, notificationStaged }
}

/** Block time on the calendar — an appointment-shaped placeholder. */
export async function blockTime(
  startIso: string,
  durationMinutes: number,
  label?: string,
  options?: JobOverrideOptions
): Promise<JobActionResult> {
  const start = new Date(startIso)
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Bad start time." }
  const minutes = Math.min(Math.max(Math.round(durationMinutes), 15), 24 * 60)
  const shop = await requireShop()
  const user = await requireUser()
  const supabase = await createClient()

  // P0-004: blocking time over an existing booking is a deliberate act —
  // warn, require a reason, record the override (owner-direct HITL, D-016).
  const gate = await ownerConflictGate({
    supabase,
    shopId: shop.id,
    userId: user.id,
    start,
    end: new Date(start.getTime() + minutes * 60_000),
    path: "owner:block_time",
    overrideReason: options?.overrideReason,
    verb: `Blocked time at ${start.toISOString()}`,
  })
  if (!gate.proceed) return gate.result

  const { data: created, error } = await supabase
    .from("appointments")
    .insert({
      shop_id: shop.id,
      scheduled_at: start.toISOString(),
      duration_minutes: minutes,
      service_name: label?.trim() || "Blocked time",
      internal_note: "[block-time]",
    })
    .select("id")
    .single()
  if (error || !created) return { ok: false, error: error?.message ?? "Couldn't block that." }
  // Best-effort C1 fields.
  await supabase
    .from("appointments")
    .update({ ends_at: new Date(start.getTime() + minutes * 60_000).toISOString() })
    .eq("id", (created as { id: string }).id)
  revalidatePath("/calendar")
  return { ok: true }
}

const PHOTO_BUCKET = "job-photos"
const MAX_PHOTO_BYTES = 8 * 1024 * 1024

export type PhotoUploadResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/** Walk-around / after photo upload → private bucket, path on the job row. */
export async function uploadJobPhoto(
  jobId: string,
  phase: "before" | "after",
  formData: FormData
): Promise<PhotoUploadResult> {
  const shop = await requireShop()
  const supabase = await createClient()
  const file = formData.get("photo")
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No photo attached." }
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: "Keep photos under 8 MB." }
  }

  const { data } = await supabase
    .from("appointments")
    .select("photos_before, photos_after")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const job = data as Pick<AppointmentRow, "photos_before" | "photos_after"> | null
  if (!job) return { ok: false, error: "Job not found." }

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 5)
  const path = `${shop.id}/${jobId}/${phase}-${randomUUID()}.${ext}`
  const service = createServiceClient()
  const { error: uploadErr } = await service.storage
    .from(PHOTO_BUCKET)
    .upload(path, file, { contentType: file.type || "image/jpeg" })
  if (uploadErr) {
    return {
      ok: false,
      error: `Upload failed (is the job-photos bucket migration applied?): ${uploadErr.message}`,
    }
  }

  const column = phase === "before" ? "photos_before" : "photos_after"
  const existing = (phase === "before" ? job.photos_before : job.photos_after) ?? []
  const { error: patchErr } = await supabase
    .from("appointments")
    .update({ [column]: [...existing, path] })
    .eq("id", jobId)
    .eq("shop_id", shop.id)
  if (patchErr) return { ok: false, error: patchErr.message }

  const { data: signed } = await service.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(path, 60 * 60)
  revalidatePath("/calendar")
  return { ok: true, url: signed?.signedUrl ?? "" }
}

/** Signed URLs for a job's photos (private bucket — 1h links). */
export async function getJobPhotoUrls(
  jobId: string
): Promise<{ before: string[]; after: string[] }> {
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("appointments")
    .select("photos_before, photos_after")
    .eq("id", jobId)
    .eq("shop_id", shop.id)
    .maybeSingle()
  const job = data as Pick<AppointmentRow, "photos_before" | "photos_after"> | null
  if (!job) return { before: [], after: [] }

  const service = createServiceClient()
  const sign = async (paths: string[] | undefined): Promise<string[]> => {
    const out: string[] = []
    for (const p of paths ?? []) {
      const { data: s } = await service.storage
        .from(PHOTO_BUCKET)
        .createSignedUrl(p, 60 * 60)
      if (s?.signedUrl) out.push(s.signedUrl)
    }
    return out
  }
  return { before: await sign(job.photos_before), after: await sign(job.photos_after) }
}
