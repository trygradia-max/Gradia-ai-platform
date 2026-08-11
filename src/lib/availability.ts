/**
 * Central appointment conflict service (P0-003).
 *
 * Answers ONE question: "is this time range bookable for this shop, and if
 * not, what conflicts with it?" — consulting (a) Gradia's own `appointments`
 * rows (the primary truth, D-013), (b) external-calendar busy times via
 * Aurinko as best-effort ADVISORY input, and (c) working hours / capacity
 * from `working-hours.ts`.
 *
 * This module is the detection foundation only. No booking, reschedule,
 * block-time, voice, or quote path calls it yet — wiring every call site is
 * P0-004. Nothing here mutates data; the service is a deterministic read.
 *
 * API:
 *   checkAvailability(supabase, shopId, { start, end, excludeAppointmentId? })
 *     → AvailabilityResult — never throws for "busy"; throws only on real
 *       errors (invalid input, appointments query failure).
 *   resolveConflictPolicy("automatic" | "hitl")
 *     → "hard_block" | "warn_allow_override" — D-015/D-016 policy encoding.
 *   ConflictOverride — the shape P0-004 call sites record when a human
 *     deliberately overrides (who, when, which conflicts). Passing it to
 *     checkAvailability NEVER suppresses detection; it is echoed back so
 *     callers can persist it alongside the still-reported conflicts.
 *
 * Tenant isolation: every query carries `.eq("shop_id", shopId)`. This
 * module runs under the caller's client — including service-role paths
 * where RLS does not backstop — so the explicit scope is mandatory.
 *
 * Time zones: overlap math runs on absolute instants (timestamptz), so it
 * is timezone-independent. Working-hours/capacity checks convert instants
 * to the shop's local wall time (`shops.timezone`, the send-policy
 * convention); an invalid timezone falls back to UTC with a logged
 * `[availability]` line.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  getAccessTokenForShop,
  listCalendarEvents,
  type AurinkoCalendarEvent,
} from "@/lib/aurinko"
import { FEATURES } from "@/lib/features"
import {
  capacityMinutesFor,
  parseTimeMinutes,
  readWorkingHours,
  weekdayOf,
  type WorkingHours,
} from "@/lib/working-hours"
import type { AppointmentRow, ShopRow } from "@/lib/types/database"

// ---------------------------------------------------------------------------
// Types — the result contract P0-004 call sites consume
// ---------------------------------------------------------------------------

export type ConflictSource =
  | "appointment"
  | "calendar"
  | "outside_hours"
  | "over_capacity"

/**
 * Overlapping bookings are "blocking" (a real double-booking); hours and
 * capacity findings are "advisory" — whether they warn or block is a caller
 * decision (ticket §4), surfaced here rather than hidden in the service.
 */
export type ConflictSeverity = "blocking" | "advisory"

export type AvailabilityConflict = {
  source: ConflictSource
  /** Conflicting record id: appointments.id or calendar event id. */
  id: string | null
  /** Busy range of the conflicting record (ISO instants) when known. */
  start: string | null
  end: string | null
  /** Human-readable reason, safe to show an owner. */
  label: string
  /** True for `[block-time]` placeholder rows. */
  blockTime: boolean
  /**
   * Resource/lane involved when current data records one (the conflicting
   * job's `access_notes.bay`). No staff/resource schema exists yet — this
   * stays null until E01/E02 model resources properly.
   */
  resource: string | null
  severity: ConflictSeverity
  metadata?: Record<string, unknown>
}

/** Why external-calendar coverage is `unchecked` (explicit — never silent). */
export type CalendarUncheckedReason = "not_connected" | "error" | "timeout"

/**
 * Internal (Gradia-owned) availability failures — the check itself could not
 * establish what Gradia's calendar holds. Founder policy: these FAIL CLOSED
 * for BOTH automatic and HITL execution — no booking, no override offered —
 * and are never conflated with external-calendar degradation (which stays
 * advisory: `calendar: "unchecked"` on an otherwise-usable result).
 */
export type AvailabilityFailureCode =
  | "invalid_input"
  | "shop_load_failed"
  | "shop_not_found"
  | "appointments_query_failed"
  | "appointments_truncated"
  | "unknown"

/** Thrown by checkAvailability for every internal failure, carrying the
 *  structured code callers store on the verification-failure summary. */
export class AvailabilityInternalError extends Error {
  readonly code: AvailabilityFailureCode

  constructor(code: AvailabilityFailureCode, message: string) {
    super(message)
    this.name = "AvailabilityInternalError"
    this.code = code
  }
}

/** Maps a caught checkAvailability error to its failure code. Anything the
 *  service throws is internal by contract (external legs never throw). */
export function internalFailureCode(err: unknown): AvailabilityFailureCode {
  return err instanceof AvailabilityInternalError ? err.code : "unknown"
}

/**
 * Recorded by P0-004 call sites when a human deliberately books through a
 * conflict (D-016). Defined here so every consumer records the same shape.
 */
export type ConflictOverride = {
  /** Who overrode — auth user id. */
  by: string
  /** When — ISO timestamp. */
  at: string
  /** Which conflicts were overridden — `conflictKey(...)` values. */
  conflicts: string[]
  reason?: string
}

export type AvailabilityResult = {
  /** True only when `conflicts` is empty. */
  available: boolean
  /** Every detected conflict, sorted deterministically. */
  conflicts: AvailabilityConflict[]
  /**
   * External-calendar coverage. "unchecked" means the answer came from
   * Gradia's own data only (calendar not connected, errored, or timed out)
   * — explicit degradation, never silent (D-013: Gradia's DB is primary).
   */
  calendar: "checked" | "unchecked"
  calendarUncheckedReason?: CalendarUncheckedReason
  /** The evaluated range, echoed as ISO instants. */
  range: { start: string; end: string }
  excludedAppointmentId: string | null
  /**
   * Override metadata echoed back verbatim. Detection above is NEVER
   * suppressed by an override — callers decide what to do with both.
   */
  override: ConflictOverride | null
}

export type CheckAvailabilityOptions = {
  /** Proposed range — ISO strings or Dates; end must be after start. */
  start: string | Date
  end: string | Date
  /**
   * Reschedule support: this appointment (and its mirrored calendar event)
   * is excluded from conflict detection.
   */
  excludeAppointmentId?: string | null
  /** Echoed into the result; never disables detection. */
  override?: ConflictOverride | null
  /** Bound on the advisory external-calendar fetch. */
  calendarTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Policy — D-015 / D-016
// ---------------------------------------------------------------------------

export type ConflictPolicyContext = "automatic" | "hitl"
export type ConflictPolicy = "hard_block" | "warn_allow_override"

/**
 * D-015: automatic scheduling (voice, autonomous, self-serve) hard-blocks
 * conflicts. D-016: human-approved scheduling may allow a documented
 * override. Callers map the policy onto behavior; the service only detects.
 */
export function resolveConflictPolicy(
  context: ConflictPolicyContext
): ConflictPolicy {
  return context === "automatic" ? "hard_block" : "warn_allow_override"
}

/** Stable key for a conflict — what `ConflictOverride.conflicts` records. */
export function conflictKey(conflict: AvailabilityConflict): string {
  return `${conflict.source}:${conflict.id ?? `${conflict.start ?? "?"}/${conflict.end ?? "?"}`}`
}

/** Enforcement acts on blocking conflicts only; advisory kinds (hours,
 *  capacity) warn on the card but never refuse (ticket §4 caller policy). */
export function blockingConflicts(
  result: Pick<AvailabilityResult, "conflicts">
): AvailabilityConflict[] {
  return result.conflicts.filter((c) => c.severity === "blocking")
}

// ---------------------------------------------------------------------------
// P0-004 — shared shapes for call sites (one algorithm, one recording shape)
// ---------------------------------------------------------------------------

/**
 * Compact availability snapshot staged onto `pending_actions.payload
 * .availability` so the approval card can render the warning, and refreshed
 * by the executor on every refusal. `error: true` means the check itself
 * failed — the card says "unverified", it NEVER fabricates "no conflicts".
 */
export type AvailabilitySummary = {
  checked_at: string
  available: boolean
  calendar: "checked" | "unchecked"
  calendar_unchecked_reason?: CalendarUncheckedReason
  conflicts: Array<{
    key: string
    source: ConflictSource
    severity: ConflictSeverity
    label: string
    start: string | null
    end: string | null
    block_time: boolean
    assumed_duration_minutes?: number
  }>
  error?: boolean
  /**
   * Present ONLY when the check itself failed internally (Gradia-owned data
   * unreadable). Distinct from BOTH a normal conflict (conflicts non-empty,
   * no error) and external-calendar degradation (a successful check with
   * `calendar: "unchecked"` + `calendar_unchecked_reason`). An internal
   * failure is never represented as mere calendar degradation.
   */
  failure?: { kind: "internal"; code: AvailabilityFailureCode }
}

export function summarizeAvailability(
  result: AvailabilityResult,
  checkedAt: string
): AvailabilitySummary {
  return {
    checked_at: checkedAt,
    available: result.available,
    calendar: result.calendar,
    ...(result.calendarUncheckedReason
      ? { calendar_unchecked_reason: result.calendarUncheckedReason }
      : {}),
    conflicts: result.conflicts.map((c) => ({
      key: conflictKey(c),
      source: c.source,
      severity: c.severity,
      label: c.label,
      start: c.start,
      end: c.end,
      block_time: c.blockTime,
      ...(typeof c.metadata?.assumed_duration_minutes === "number"
        ? { assumed_duration_minutes: c.metadata.assumed_duration_minutes }
        : {}),
    })),
  }
}

/**
 * The summary recorded when the check itself failed INTERNALLY (honest,
 * fail-closed). Note what it does NOT carry: a `calendar_unchecked_reason`.
 * That field describes external-calendar degradation on a completed check;
 * an internal Gradia failure is a different, stricter condition and must
 * never be downgraded to "calendar unchecked" (founder policy).
 */
export function unverifiedAvailabilitySummary(
  checkedAt: string,
  code: AvailabilityFailureCode = "unknown"
): AvailabilitySummary {
  return {
    checked_at: checkedAt,
    available: false,
    calendar: "unchecked",
    conflicts: [],
    error: true,
    failure: { kind: "internal", code },
  }
}

const conflictOverrideSchema = z.object({
  by: z.string().trim().min(1),
  at: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "override.at must be an ISO timestamp"),
  conflicts: z.array(z.string().min(1)),
  reason: z.string().trim().min(1, "an override needs a reason"),
})

export type ConflictOverrideCheck =
  | { ok: true; override: ConflictOverride }
  | { ok: false; reason: string }

/**
 * D-016 gatekeeper, shared by every HITL executor. An override is honored
 * ONLY when it is well-formed (actor, reason, timestamp, conflict keys),
 * was recorded by the human who is approving right now, and covers every
 * blocking conflict the execution-time re-check found — a stale override
 * never absorbs a conflict its author did not see. Detection is never
 * suppressed either way; this only decides whether execution may proceed.
 */
export function validateConflictOverride(
  raw: unknown,
  input: { approverUserId: string | null; blocking: AvailabilityConflict[] }
): ConflictOverrideCheck {
  if (raw == null) return { ok: false, reason: "no override recorded" }
  const parsed = conflictOverrideSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        parsed.error.issues[0]?.message ?? "override metadata is incomplete",
    }
  }
  if (!input.approverUserId || parsed.data.by !== input.approverUserId) {
    return {
      ok: false,
      reason: "override was not recorded by the approving owner",
    }
  }
  const covered = new Set(parsed.data.conflicts)
  const uncovered = input.blocking.filter((c) => !covered.has(conflictKey(c)))
  if (uncovered.length > 0) {
    return {
      ok: false,
      reason: `the schedule changed since the override — ${uncovered.length} new conflict${uncovered.length === 1 ? "" : "s"} found`,
    }
  }
  return { ok: true, override: parsed.data }
}

/**
 * Staging-time advisory check (ticket §1) — one call every staging site
 * shares. Never throws. On an INTERNAL check failure it returns the honest
 * verification-failure summary plus a `failure` code: pure staging surfaces
 * may still stage the card (it stays pending — a human decides, and the
 * executor's own gate fails closed), but any caller that EXECUTES directly
 * (owner drag-reschedule, block-time) must refuse when `failure` is set.
 * Blocking conflicts are returned so AUTOMATIC staging paths (voice) can
 * refuse to stage a knowingly-conflicting booking; HITL surfaces attach the
 * summary and let the owner decide. Flag off → `{ summary: null,
 * blocking: [], failure: null }` (dormant).
 */
export async function stagingAvailability(
  supabase: SupabaseClient,
  shopId: string,
  options: {
    start: string | Date
    end: string | Date
    excludeAppointmentId?: string | null
    /** Telemetry label, e.g. "stage:voice_propose_booking". */
    path: string
    /** Test hook; defaults to the P0-004 feature flag. */
    enabled?: boolean
  }
): Promise<{
  summary: AvailabilitySummary | null
  blocking: AvailabilityConflict[]
  /** Set when the check failed INTERNALLY — direct-execution callers refuse. */
  failure: AvailabilityFailureCode | null
}> {
  const enabled = options.enabled ?? FEATURES.conflictEnforcement
  if (!enabled) return { summary: null, blocking: [], failure: null }
  const checkedAt = new Date().toISOString()
  try {
    const result = await checkAvailability(supabase, shopId, {
      start: options.start,
      end: options.end,
      excludeAppointmentId: options.excludeAppointmentId ?? null,
    })
    const summary = summarizeAvailability(result, checkedAt)
    const blocking = blockingConflicts(result)
    if (blocking.length > 0) {
      emitConflictEvent("booking_conflict_detected", {
        shopId,
        path: options.path,
        conflictKeys: blocking.map(conflictKey),
      })
    }
    return { summary, blocking, failure: null }
  } catch (err) {
    const code = internalFailureCode(err)
    console.warn(
      `[availability] staging check failed for shop ${shopId} (${options.path}, code=${code}) — availability is UNVERIFIED; execution paths fail closed:`,
      err instanceof Error ? err.message : err
    )
    return {
      summary: unverifiedAvailabilitySummary(checkedAt, code),
      blocking: [],
      failure: code,
    }
  }
}

export type ConflictTelemetryEvent =
  | "booking_conflict_detected"
  | "booking_conflict_overridden"
  | "booking_conflict_blocked_automatic"

/**
 * Internal telemetry (14-product-analytics naming). The event pipeline is an
 * open founder decision (storage vs vendor, decision queue), so these emit
 * as structured `[availability]` log lines — the exact names are stable so
 * P0-012 alert routing and the future events table can consume them as-is.
 */
export function emitConflictEvent(
  event: ConflictTelemetryEvent,
  details: {
    shopId: string
    path: string
    actionId?: string | null
    conflictKeys: string[]
  }
): void {
  console.info(
    `[availability] event=${event} shop=${details.shopId} path=${details.path}${details.actionId ? ` action=${details.actionId}` : ""} conflicts=${details.conflictKeys.join(",") || "-"}`
  )
}

// ---------------------------------------------------------------------------
// Pure overlap math (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Half-open interval [start, end) overlap: a boundary touch (one range
 * ending exactly when the other starts) is NOT a conflict.
 */
export function rangesOverlap(
  aStartMs: number,
  aEndMs: number,
  bStartMs: number,
  bEndMs: number
): boolean {
  return aStartMs < bEndMs && bStartMs < aEndMs
}

const DEFAULT_DURATION_MINUTES = 90
/** Rows starting up to this long before the range are still fetched, so
 *  long/multi-day appointments (ends_at or duration spanning the range
 *  start) are never missed. Nothing in the product books longer than this. */
const OVERLAP_LOOKBACK_MS = 7 * 24 * 60 * 60_000
const DEFAULT_CALENDAR_TIMEOUT_MS = 3_500
const APPOINTMENT_FETCH_LIMIT = 1_000

/** Statuses that no longer occupy the calendar. Cancelled appointments are
 *  deleted outright (executeCancelAppointment), so `closed` is the only
 *  terminal status; anything unknown counts as busy (conservative). */
const NON_BUSY_STATUSES = new Set<string>(["closed"])
const KNOWN_STATUSES = new Set<string>([
  "booked",
  "confirmed",
  "checked_in",
  "in_progress",
  "on_hold",
  "completed",
  "paid",
  "closed",
])

type BusyRange = { startMs: number; endMs: number }

type BusyRangeWithProvenance = BusyRange & {
  /** True when neither ends_at nor duration existed and the 90-minute
   *  default decided the end — surfaced in conflict metadata (never a
   *  silent assumption). */
  assumedDefaultDuration: boolean
}

/**
 * An appointment row's occupied range: `ends_at` when valid, else
 * `scheduled_at + duration_minutes` (90 when unset — every reader's
 * default, flagged via `assumedDefaultDuration` wherever it decides a
 * result). Returns null (never throws) for rows with unparseable times.
 */
export function appointmentBusyRange(
  row: Pick<AppointmentRow, "scheduled_at" | "duration_minutes" | "ends_at">
): BusyRangeWithProvenance | null {
  const startMs = Date.parse(row.scheduled_at ?? "")
  if (Number.isNaN(startMs)) return null
  const endsAtMs = row.ends_at ? Date.parse(row.ends_at) : Number.NaN
  if (!Number.isNaN(endsAtMs) && endsAtMs > startMs) {
    return { startMs, endMs: endsAtMs, assumedDefaultDuration: false }
  }
  const hasDuration =
    typeof row.duration_minutes === "number" && row.duration_minutes > 0
  const minutes = hasDuration
    ? (row.duration_minutes as number)
    : DEFAULT_DURATION_MINUTES
  return {
    startMs,
    endMs: startMs + minutes * 60_000,
    assumedDefaultDuration: !hasDuration,
  }
}

/** Whether a row still occupies its slot. Unknown statuses are busy. */
export function isBusyStatus(status: string | null | undefined): boolean {
  if (status == null) return true // pre-C1 rows: booked/confirmed
  if (NON_BUSY_STATUSES.has(status)) return false
  if (!KNOWN_STATUSES.has(status)) {
    console.warn(
      `[availability] unknown appointment status "${status}" — counting as busy`
    )
  }
  return true
}

type AppointmentCandidate = Pick<
  AppointmentRow,
  | "id"
  | "scheduled_at"
  | "duration_minutes"
  | "ends_at"
  | "service_name"
  | "internal_note"
  | "status"
  | "access_notes"
  | "customer_id"
  | "aurinko_event_id"
>

const BLOCK_TIME_NOTE = "[block-time]"

/** Appointment-sourced conflicts for the proposed range (pure). */
export function appointmentConflicts(
  rows: AppointmentCandidate[],
  proposedStartMs: number,
  proposedEndMs: number,
  excludeAppointmentId?: string | null
): AvailabilityConflict[] {
  const out: AvailabilityConflict[] = []
  for (const row of rows) {
    if (excludeAppointmentId && row.id === excludeAppointmentId) continue
    if (!isBusyStatus(row.status ?? null)) continue
    const busy = appointmentBusyRange(row)
    if (!busy) {
      console.warn(
        `[availability] appointment ${row.id} has unparseable times — skipped (not counted as conflicting)`
      )
      continue
    }
    if (!rangesOverlap(busy.startMs, busy.endMs, proposedStartMs, proposedEndMs)) {
      continue
    }
    const isBlock = row.internal_note === BLOCK_TIME_NOTE
    const bay =
      row.access_notes && typeof row.access_notes.bay === "string"
        ? row.access_notes.bay
        : null
    const label = isBlock
      ? `Blocked time${row.service_name && row.service_name !== "Blocked time" ? ` (${row.service_name})` : ""} from ${new Date(busy.startMs).toISOString()} to ${new Date(busy.endMs).toISOString()}`
      : `Existing ${row.service_name ?? "appointment"} from ${new Date(busy.startMs).toISOString()} to ${new Date(busy.endMs).toISOString()}`
    out.push({
      source: "appointment",
      id: row.id,
      start: new Date(busy.startMs).toISOString(),
      end: new Date(busy.endMs).toISOString(),
      label,
      blockTime: isBlock,
      resource: bay,
      severity: "blocking",
      metadata: {
        status: row.status ?? null,
        customer_id: row.customer_id ?? null,
        // Gate 6 (P0-004): when the 90-minute default decided this row's
        // end time, say so — callers and cards can show the assumption.
        ...(busy.assumedDefaultDuration
          ? { assumed_duration_minutes: DEFAULT_DURATION_MINUTES }
          : {}),
      },
    })
  }
  return out
}

/** Calendar-sourced conflicts (advisory input, D-013). Events mirroring a
 *  Gradia appointment (matching aurinko_event_id) are skipped so one
 *  booking never reports twice — and a reschedule never collides with its
 *  own mirror event. */
export function calendarConflicts(
  events: AurinkoCalendarEvent[],
  proposedStartMs: number,
  proposedEndMs: number,
  mirroredEventIds: ReadonlySet<string>
): AvailabilityConflict[] {
  const out: AvailabilityConflict[] = []
  for (const event of events) {
    if (event.id && mirroredEventIds.has(event.id)) continue
    const startMs = event.start ? Date.parse(event.start) : Number.NaN
    const endMs = event.end ? Date.parse(event.end) : Number.NaN
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      console.warn(
        `[availability] calendar event ${event.id || "(no id)"} has unparseable times — skipped`
      )
      continue
    }
    if (!rangesOverlap(startMs, endMs, proposedStartMs, proposedEndMs)) continue
    out.push({
      source: "calendar",
      id: event.id || null,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      label: `Calendar event${event.subject ? ` "${event.subject}"` : ""} from ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}`,
      blockTime: false,
      resource: null,
      severity: "blocking",
      metadata: { subject: event.subject ?? null },
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Shop-local wall time (working hours / capacity)
// ---------------------------------------------------------------------------

type LocalWallTime = {
  /** Minutes since local midnight, 0–1439. */
  minutesOfDay: number
  /** Local calendar day key, "YYYY-MM-DD". */
  dayKey: string
  /** Local weekday via a Date carrying the local Y/M/D. */
  localDate: Date
}

/** Converts an instant to the shop's local wall time. Invalid timezone →
 *  UTC fallback, logged (matches the send-policy convention). */
export function toLocalWallTime(ms: number, timezone: string): LocalWallTime {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms))
  } catch {
    console.warn(
      `[availability] invalid shop timezone "${timezone}" — falling back to UTC`
    )
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms))
  }
  const get = (type: Intl.DateTimeFormatPart["type"]): string =>
    parts.find((p) => p.type === type)?.value ?? "0"
  const year = Number(get("year"))
  const month = Number(get("month"))
  const day = Number(get("day"))
  const hour = Number(get("hour"))
  const minute = Number(get("minute"))
  return {
    minutesOfDay: hour * 60 + minute,
    dayKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    localDate: new Date(year, month - 1, day),
  }
}

/** Enumerates each local day the range touches, walking in 24h steps from
 *  the start instant (plus the end instant's day). */
function localDaysSpanned(
  startMs: number,
  endMs: number,
  timezone: string
): LocalWallTime[] {
  const days = new Map<string, LocalWallTime>()
  for (let ms = startMs; ms < endMs; ms += 24 * 60 * 60_000) {
    const local = toLocalWallTime(ms, timezone)
    if (!days.has(local.dayKey)) days.set(local.dayKey, local)
  }
  // endMs is exclusive; sample just inside the range for the final day.
  const lastLocal = toLocalWallTime(Math.max(startMs, endMs - 1), timezone)
  if (!days.has(lastLocal.dayKey)) days.set(lastLocal.dayKey, lastLocal)
  return [...days.values()]
}

/**
 * Outside-hours + over-capacity conflicts (pure, advisory). For every shop-
 * local day the proposal touches: the proposed wall-time window must sit
 * inside that day's open/close (closed day = fully outside), and the day's
 * total occupied minutes (existing busy rows clipped to the day, plus the
 * proposal) must not exceed workable minutes.
 */
export function hoursAndCapacityConflicts(
  proposedStartMs: number,
  proposedEndMs: number,
  timezone: string,
  workingHours: WorkingHours,
  existingBusy: BusyRange[]
): AvailabilityConflict[] {
  const out: AvailabilityConflict[] = []
  const days = localDaysSpanned(proposedStartMs, proposedEndMs, timezone)
  const spansDays = days.length > 1

  for (const day of days) {
    const weekday = weekdayOf(day.localDate)
    const dayHours = workingHours[weekday]
    const capacity = capacityMinutesFor(workingHours, day.localDate)

    // The proposal's wall-time window within THIS local day.
    const startLocal = toLocalWallTime(proposedStartMs, timezone)
    const endLocal = toLocalWallTime(proposedEndMs - 1, timezone) // inclusive sample
    const windowStartMin =
      startLocal.dayKey === day.dayKey ? startLocal.minutesOfDay : 0
    const windowEndMin =
      endLocal.dayKey === day.dayKey ? endLocal.minutesOfDay + 1 : 24 * 60

    if (!dayHours) {
      out.push({
        source: "outside_hours",
        id: null,
        start: null,
        end: null,
        label: `The shop is closed on ${day.dayKey}.`,
        blockTime: false,
        resource: null,
        severity: "advisory",
        metadata: { day: day.dayKey, weekday },
      })
      continue
    }

    const openMin = parseTimeMinutes(dayHours.open) ?? 0
    const closeMin = parseTimeMinutes(dayHours.close) ?? 24 * 60
    if (windowStartMin < openMin || windowEndMin > closeMin) {
      out.push({
        source: "outside_hours",
        id: null,
        start: null,
        end: null,
        label: `Outside working hours on ${day.dayKey} (open ${dayHours.open}–${dayHours.close}).`,
        blockTime: false,
        resource: null,
        severity: "advisory",
        metadata: { day: day.dayKey, weekday, open: dayHours.open, close: dayHours.close },
      })
    }

    // Capacity: existing busy minutes on this local day + the proposal's
    // minutes on this local day vs workable minutes.
    const proposedMinutes = minutesOnLocalDay(
      { startMs: proposedStartMs, endMs: proposedEndMs },
      day.dayKey,
      timezone
    )
    let bookedMinutes = 0
    for (const busy of existingBusy) {
      bookedMinutes += minutesOnLocalDay(busy, day.dayKey, timezone)
    }
    if (capacity > 0 && bookedMinutes + proposedMinutes > capacity) {
      out.push({
        source: "over_capacity",
        id: null,
        start: null,
        end: null,
        label: `Over capacity on ${day.dayKey}: ${bookedMinutes} booked + ${proposedMinutes} proposed of ${capacity} workable minutes.`,
        blockTime: false,
        resource: null,
        severity: "advisory",
        metadata: {
          day: day.dayKey,
          bookedMinutes,
          proposedMinutes,
          capacityMinutes: capacity,
          spansDays,
        },
      })
    }
  }
  return out
}

/** Minutes of a busy range that fall on the given local day. */
function minutesOnLocalDay(
  busy: BusyRange,
  dayKey: string,
  timezone: string
): number {
  let minutes = 0
  // Minute-walk is exact but slow; step in 15-minute quanta (appointments
  // are quarter-hour granular in practice) and clamp to the busy range.
  const STEP = 15 * 60_000
  for (let ms = busy.startMs; ms < busy.endMs; ms += STEP) {
    const stepEnd = Math.min(ms + STEP, busy.endMs)
    if (toLocalWallTime(ms, timezone).dayKey === dayKey) {
      minutes += Math.round((stepEnd - ms) / 60_000)
    }
  }
  return minutes
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

function toInstantMs(value: string | Date, field: "start" | "end"): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new AvailabilityInternalError(
      "invalid_input",
      `[availability] invalid ${field} time: ${String(value)}`
    )
  }
  return ms
}

/** Bounded external-calendar fetch: null = timed out. The timeout ABORTS
 *  the underlying request (P0-004 gate 4) — no abandoned socket keeps the
 *  vendor call running after the answer stopped mattering. */
async function fetchCalendarEventsBounded(
  accessToken: string,
  calendarId: string,
  range: { timeMin: string; timeMax: string },
  timeoutMs: number
): Promise<AurinkoCalendarEvent[] | null> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      listCalendarEvents(accessToken, calendarId, range, {
        signal: controller.signal,
      }).catch((err: unknown) => {
        // An abort we caused is the timeout answer, not an error.
        if (controller.signal.aborted) return null
        throw err
      }),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The central conflict check. Deterministic for identical inputs + data
 * state; read-only; never throws for "busy" — throws only on a real error
 * (invalid input, a failed appointments query, or a row-capped fetch that
 * cannot see every possibly-overlapping row): without complete Gradia data
 * there is no answer, and guessing "available" would invite double-booking.
 */
export async function checkAvailability(
  supabase: SupabaseClient,
  shopId: string,
  options: CheckAvailabilityOptions
): Promise<AvailabilityResult> {
  if (!shopId) {
    throw new AvailabilityInternalError(
      "invalid_input",
      "[availability] shopId is required"
    )
  }
  const startMs = toInstantMs(options.start, "start")
  const endMs = toInstantMs(options.end, "end")
  if (endMs <= startMs) {
    throw new AvailabilityInternalError(
      "invalid_input",
      `[availability] invalid range: end (${new Date(endMs).toISOString()}) must be after start (${new Date(startMs).toISOString()})`
    )
  }
  const excludeAppointmentId = options.excludeAppointmentId ?? null
  const override = options.override ?? null

  // Shop row: timezone + working hours + Aurinko token material. Missing
  // shop = real error (a caller passed a bad tenant id).
  const { data: shopData, error: shopErr } = await supabase
    .from("shops")
    .select(
      "id, timezone, settings, aurinko_account_id, aurinko_access_token_enc, aurinko_token_expires_at"
    )
    .eq("id", shopId)
    .maybeSingle()
  if (shopErr) {
    throw new AvailabilityInternalError(
      "shop_load_failed",
      `[availability] shop load failed: ${shopErr.message}`
    )
  }
  const shop = shopData as
    | (Pick<
        ShopRow,
        | "id"
        | "timezone"
        | "settings"
        | "aurinko_account_id"
        | "aurinko_access_token_enc"
        | "aurinko_token_expires_at"
      >)
    | null
  if (!shop) {
    throw new AvailabilityInternalError(
      "shop_not_found",
      `[availability] shop not found: ${shopId}`
    )
  }
  const timezone = shop.timezone || "UTC"

  // Fetch window: widened to whole local days (capacity math needs the full
  // day) plus a lookback so long rows that START before the window but END
  // inside it are still seen (`ends_at` can be null, so the DB can't filter
  // on end time).
  const dayPadMs = 36 * 60 * 60_000 // covers any local-day offset + DST
  const fetchStartIso = new Date(
    startMs - dayPadMs - OVERLAP_LOOKBACK_MS
  ).toISOString()
  const fetchEndIso = new Date(endMs + dayPadMs).toISOString()

  const { data: apptData, error: apptErr } = await supabase
    .from("appointments")
    .select(
      "id, scheduled_at, duration_minutes, ends_at, service_name, internal_note, status, access_notes, customer_id, aurinko_event_id"
    )
    .eq("shop_id", shopId)
    .gte("scheduled_at", fetchStartIso)
    .lt("scheduled_at", fetchEndIso)
    .order("scheduled_at", { ascending: true })
    .limit(APPOINTMENT_FETCH_LIMIT)
  if (apptErr) {
    throw new AvailabilityInternalError(
      "appointments_query_failed",
      `[availability] appointments query failed: ${apptErr.message}`
    )
  }
  const rows = (apptData as AppointmentCandidate[] | null) ?? []
  if (rows.length === APPOINTMENT_FETCH_LIMIT) {
    // Fail closed. A capped fetch means rows that could overlap were left
    // unread (the fetch is ordered by scheduled_at, so a truncation drops the
    // rows nearest the proposed range), and answering "available" would be a
    // guess — the exact guess this service exists to prevent. Same rationale
    // as the appointments-query-failure throw above; at pilot scale this cap
    // is never reached (a shop books nowhere near 1,000 rows in this window).
    throw new AvailabilityInternalError(
      "appointments_truncated",
      `[availability] appointment fetch hit the ${APPOINTMENT_FETCH_LIMIT}-row cap for shop ${shopId} — refusing to answer rather than risk a false "available"; narrow the range or add pagination before this scale is real`
    )
  }

  // (a) Appointment conflicts — Gradia's own data, the primary truth.
  const conflicts: AvailabilityConflict[] = appointmentConflicts(
    rows,
    startMs,
    endMs,
    excludeAppointmentId
  )

  // (c) Working hours + capacity (advisory kinds). Busy ranges for capacity
  // exclude the rescheduling appointment itself.
  const workingHours = readWorkingHours(shop.settings)
  const busyRanges: BusyRange[] = []
  for (const row of rows) {
    if (excludeAppointmentId && row.id === excludeAppointmentId) continue
    if (!isBusyStatus(row.status ?? null)) continue
    const busy = appointmentBusyRange(row)
    if (busy) busyRanges.push(busy)
  }
  conflicts.push(
    ...hoursAndCapacityConflicts(startMs, endMs, timezone, workingHours, busyRanges)
  )

  // (b) External calendar — best-effort ADVISORY input. Failure or absence
  // degrades to `calendar: "unchecked"` with a logged reason; the service
  // still answers from Gradia's own data (D-013).
  let calendar: "checked" | "unchecked" = "unchecked"
  let calendarUncheckedReason: CalendarUncheckedReason | undefined
  try {
    const accessToken = await getAccessTokenForShop(supabase, shop)
    if (!accessToken) {
      calendarUncheckedReason = "not_connected"
    } else {
      const events = await fetchCalendarEventsBounded(
        accessToken,
        "primary",
        {
          timeMin: new Date(startMs).toISOString(),
          timeMax: new Date(endMs).toISOString(),
        },
        options.calendarTimeoutMs ?? DEFAULT_CALENDAR_TIMEOUT_MS
      )
      if (events === null) {
        calendarUncheckedReason = "timeout"
        console.warn(
          `[availability] calendar fetch timed out for shop ${shopId} — answering from Gradia data only (calendar: unchecked)`
        )
      } else {
        const mirroredEventIds = new Set<string>()
        for (const row of rows) {
          if (row.aurinko_event_id) mirroredEventIds.add(row.aurinko_event_id)
        }
        conflicts.push(
          ...calendarConflicts(events, startMs, endMs, mirroredEventIds)
        )
        calendar = "checked"
      }
    }
  } catch (err) {
    calendarUncheckedReason = "error"
    console.warn(
      `[availability] calendar fetch failed for shop ${shopId} — answering from Gradia data only (calendar: unchecked):`,
      err instanceof Error ? err.message : err
    )
  }

  // Deterministic ordering: source, then start, then id.
  conflicts.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source)
    const as = a.start ?? ""
    const bs = b.start ?? ""
    if (as !== bs) return as.localeCompare(bs)
    return (a.id ?? "").localeCompare(b.id ?? "")
  })

  return {
    available: conflicts.length === 0,
    conflicts,
    calendar,
    ...(calendarUncheckedReason ? { calendarUncheckedReason } : {}),
    range: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    },
    excludedAppointmentId: excludeAppointmentId,
    override,
  }
}
