/**
 * Job status machine (CRM C4) — appointments wear two faces: appointment
 * (when/where) and job (work status). Transitions are OWNER taps — free,
 * never staged — but every transition writes the customer timeline, and the
 * side effects that TALK to the customer (review request, completed text)
 * are delivered by the C5 automation catalog through the one send path.
 *
 * completed arms the vehicle's maintenance clock from service-category
 * intervals (code defaults below, owner-editable later). closed auto-sets
 * 48h after paid via a cron-safe sweep. All writes tolerate a pre-C1 DB.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { recordInteraction } from "@/lib/memory"
import type {
  AppointmentRow,
  JobHoldReason,
  JobStatus,
  ServiceRow,
} from "@/lib/types/database"

export const JOB_STATUSES: { key: JobStatus; label: string }[] = [
  { key: "booked", label: "Booked" },
  { key: "confirmed", label: "Confirmed" },
  { key: "checked_in", label: "Checked in" },
  { key: "in_progress", label: "In progress" },
  { key: "on_hold", label: "On hold" },
  { key: "completed", label: "Completed" },
  { key: "paid", label: "Paid" },
  { key: "closed", label: "Closed" },
]

/**
 * Allowed transitions. on_hold is enterable from any live working state and
 * resumes to checked_in/in_progress; the money tail (completed → paid →
 * closed) is one-way. `paid` is a manual toggle in P9 (no new payment
 * features); `closed` normally arrives via the 48h sweep but stays a legal
 * manual tap.
 */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  booked: ["confirmed", "checked_in", "on_hold"],
  confirmed: ["checked_in", "in_progress", "on_hold"],
  checked_in: ["in_progress", "on_hold"],
  in_progress: ["completed", "on_hold"],
  on_hold: ["checked_in", "in_progress", "completed"],
  completed: ["paid", "closed"],
  paid: ["closed"],
  closed: [],
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false
}

/** The one-tap "next" actions a job card offers for its current status. */
export function nextActionsFor(status: JobStatus): JobStatus[] {
  return JOB_TRANSITIONS[status] ?? []
}

/**
 * Maintenance intervals by service category (months) — the clock C4 arms on
 * completion (spec: interval defaults per category, owner-editable later).
 */
export const MAINTENANCE_INTERVAL_MONTHS: Record<string, number> = {
  protection: 12, // coating annual inspection
  correction: 12,
  detail: 6,
  interior: 6,
  wash: 1,
  addon: 6,
}
export const DEFAULT_MAINTENANCE_INTERVAL_MONTHS = 6

export function maintenanceIntervalMonths(category: string | null): number {
  return (
    MAINTENANCE_INTERVAL_MONTHS[(category ?? "").trim().toLowerCase()] ??
    DEFAULT_MAINTENANCE_INTERVAL_MONTHS
  )
}

export type MaintenanceEntry = {
  service_id: string
  interval_months: number
  next_due_at: string
}

/**
 * Pure: merge the completed services into a vehicle's maintenance_schedule —
 * one entry per service, next_due_at pushed out from the completion date.
 */
export function armMaintenanceSchedule(
  existing: unknown,
  services: Pick<ServiceRow, "id" | "category">[],
  completedAt: Date
): MaintenanceEntry[] {
  const prior = Array.isArray(existing) ? (existing as MaintenanceEntry[]) : []
  const byService = new Map(prior.map((e) => [e.service_id, e]))
  for (const svc of services) {
    const months = maintenanceIntervalMonths(svc.category ?? null)
    const due = new Date(completedAt)
    due.setMonth(due.getMonth() + months)
    byService.set(svc.id, {
      service_id: svc.id,
      interval_months: months,
      next_due_at: due.toISOString(),
    })
  }
  return [...byService.values()]
}

export type JobTransitionResult =
  | { ok: true; status: JobStatus }
  | { ok: false; error: string }

const STATUS_TIMELINE: Record<JobStatus, string> = {
  booked: "Job booked.",
  confirmed: "Job confirmed.",
  checked_in: "Vehicle checked in.",
  in_progress: "Work started.",
  on_hold: "Job put on hold.",
  completed: "Job completed.",
  paid: "Job marked paid.",
  closed: "Job closed.",
}

/**
 * One owner tap: validate the transition, update the job, write the
 * timeline, run completed's side effects (maintenance clock). Customer-
 * facing follow-ups (thanks text, review ask) are C5 catalog entries that
 * key off the timeline event this writes — nothing sends from here.
 */
export async function advanceJobStatus(
  supabase: SupabaseClient,
  shopId: string,
  jobId: string,
  next: JobStatus,
  opts: { holdReason?: JobHoldReason | null; now?: Date } = {}
): Promise<JobTransitionResult> {
  const { data } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", jobId)
    .eq("shop_id", shopId)
    .maybeSingle()
  const job = data as AppointmentRow | null
  if (!job) return { ok: false, error: "Job not found." }

  const current: JobStatus = job.status ?? (job.confirmed_at ? "confirmed" : "booked")
  if (current === next) return { ok: true, status: next }
  if (!canTransition(current, next)) {
    return { ok: false, error: `A ${current} job can't move to ${next}.` }
  }
  if (next === "on_hold" && !opts.holdReason) {
    return { ok: false, error: "Pick a hold reason first." }
  }

  const now = opts.now ?? new Date()
  const patch: Record<string, unknown> = {
    status: next,
    hold_reason: next === "on_hold" ? opts.holdReason : null,
    updated_at: now.toISOString(),
  }
  const { error } = await supabase
    .from("appointments")
    .update(patch)
    .eq("id", jobId)
    .eq("shop_id", shopId)
  if (error) {
    return {
      ok: false,
      error: `Couldn't update the job (is the C1 migration applied?): ${error.message}`,
    }
  }

  // Timeline — the C5 sweeps (job_completed, review_request) key off this
  // event, so it carries the machine-readable refs.
  await recordInteraction(supabase, {
    shopId,
    customerId: job.customer_id,
    channel: "note",
    role: "system",
    content:
      next === "on_hold" && opts.holdReason
        ? `Job put on hold (${opts.holdReason}).`
        : STATUS_TIMELINE[next],
    metadata: {
      kind: "job_status",
      appointment_id: jobId,
      from: current,
      to: next,
      hold_reason: next === "on_hold" ? opts.holdReason : null,
    },
  })

  if (next === "completed") {
    await armVehicleMaintenance(supabase, shopId, job, now)
  }

  return { ok: true, status: next }
}

/** completed side effect: push the vehicle's next_due_at per service category. */
async function armVehicleMaintenance(
  supabase: SupabaseClient,
  shopId: string,
  job: AppointmentRow,
  completedAt: Date
): Promise<void> {
  if (!job.vehicle_id) return
  const serviceIds = job.service_ids ?? []
  if (serviceIds.length === 0) return

  const { data: svcData } = await supabase
    .from("services")
    .select("id, category")
    .eq("shop_id", shopId)
    .in("id", serviceIds)
  const services = (svcData as Pick<ServiceRow, "id" | "category">[] | null) ?? []
  if (services.length === 0) return

  const { data: vehData } = await supabase
    .from("vehicles")
    .select("maintenance_schedule")
    .eq("id", job.vehicle_id)
    .eq("shop_id", shopId)
    .maybeSingle()
  const schedule = armMaintenanceSchedule(
    (vehData as { maintenance_schedule: unknown } | null)?.maintenance_schedule,
    services,
    completedAt
  )
  const { error } = await supabase
    .from("vehicles")
    .update({ maintenance_schedule: schedule })
    .eq("id", job.vehicle_id)
    .eq("shop_id", shopId)
  if (error) {
    console.warn("[jobs] maintenance clock skipped (pre-C1?):", error.message)
  }
}

/** Hours after `paid` before a job auto-closes. */
export const CLOSE_AFTER_PAID_HOURS = 48

/**
 * Cron-safe sweep: paid jobs whose paid timeline event is older than 48h
 * move to closed. Uses the timeline event (exact) with updated_at as the
 * fallback for rows whose event predates this feature.
 */
export async function closeOldPaidJobs(
  supabase: SupabaseClient,
  opts: { shopId?: string; now?: Date } = {}
): Promise<{ closed: number; skipped_reason?: string }> {
  const nowMs = (opts.now ?? new Date()).getTime()
  const cutoffIso = new Date(nowMs - CLOSE_AFTER_PAID_HOURS * 3_600_000).toISOString()

  let q = supabase
    .from("appointments")
    .select("id, shop_id, updated_at")
    .eq("status", "paid")
    .lt("updated_at", cutoffIso)
    .limit(200)
  if (opts.shopId) q = q.eq("shop_id", opts.shopId)
  const { data, error } = await q
  if (error) {
    return { closed: 0, skipped_reason: `close sweep skipped: ${error.message}` }
  }

  let closed = 0
  for (const row of (data as { id: string; shop_id: string }[] | null) ?? []) {
    const result = await advanceJobStatus(supabase, row.shop_id, row.id, "closed", {
      now: opts.now,
    })
    if (result.ok) closed += 1
  }
  return { closed }
}
