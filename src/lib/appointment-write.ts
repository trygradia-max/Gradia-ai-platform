/**
 * The one serialized appointment-write path (P0-004A, issue #13).
 *
 * Every mutation of an appointment's time range — booking insert, block-time
 * insert, reschedule move — goes through `write_appointment_serialized`
 * (migration 20260811120000): a single Postgres transaction that takes a
 * per-shop advisory lock, re-verifies busy overlap UNDER the lock, and then
 * writes. This closes the check→insert TOCTOU race across all application
 * instances; two concurrent conflicting requests serialize and exactly one
 * wins (unless a validated D-016 override covers the conflict).
 *
 * Division of labor (locked): `src/lib/availability.ts` remains the single
 * application-level conflict algorithm — hours/capacity kinds, calendar leg,
 * labels, D-015/D-016 policy. The SQL check inside the RPC is only the
 * transactional invariant (blocking appointment overlap, same busy
 * semantics). Callers still run the TS gate first for policy + honest
 * conflict payloads; the RPC is the last-line race guard.
 *
 * Idempotency: `p_pending_action_id` links an approved action to its
 * appointment (partial UNIQUE). A replayed or re-driven approval gets
 * `status: "exists"` with the original row id — never a duplicate.
 *
 * Tenant isolation: the lock key, the replay lookup, the overlap check, and
 * both write statements are all scoped by `p_shop_id`; the function runs
 * SECURITY INVOKER so session callers additionally stay under RLS.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** Serialized-write outcome. `conflict` = a blocking row (not covered by the
 *  supplied override) exists in-lock — the caller refuses and re-runs the TS
 *  service for an honest, labeled summary. */
export type SerializedWriteResult =
  | { status: "inserted" | "updated" | "exists"; id: string }
  | { status: "conflict"; conflictIds: string[] }
  | { status: "not_found" }

export type SerializedInsertInput = {
  mode: "insert"
  start: Date
  end: Date
  /** Appointment ids a validated ConflictOverride covers (D-016). */
  coveredIds?: string[]
  /** Idempotency key — the approved pending action producing this row. */
  pendingActionId?: string | null
  leadId?: string | null
  customerId?: string | null
  durationMinutes?: number | null
  serviceName?: string | null
  timezone?: string | null
  internalNote?: string | null
}

export type SerializedMoveInput = {
  mode: "move"
  appointmentId: string
  start: Date
  end: Date
  coveredIds?: string[]
}

/**
 * Executes the serialized write. Throws only on real errors (RPC failure,
 * malformed response) — a busy slot is a `conflict` result, never a throw.
 */
export async function writeAppointmentSerialized(
  supabase: SupabaseClient,
  shopId: string,
  input: SerializedInsertInput | SerializedMoveInput
): Promise<SerializedWriteResult> {
  const { data, error } = await supabase.rpc("write_appointment_serialized", {
    p_shop_id: shopId,
    p_start: input.start.toISOString(),
    p_end: input.end.toISOString(),
    p_covered_ids: input.coveredIds ?? [],
    p_appointment_id: input.mode === "move" ? input.appointmentId : null,
    p_pending_action_id:
      input.mode === "insert" ? (input.pendingActionId ?? null) : null,
    p_lead_id: input.mode === "insert" ? (input.leadId ?? null) : null,
    p_customer_id: input.mode === "insert" ? (input.customerId ?? null) : null,
    p_duration_minutes:
      input.mode === "insert" ? (input.durationMinutes ?? null) : null,
    p_service_name: input.mode === "insert" ? (input.serviceName ?? null) : null,
    p_timezone: input.mode === "insert" ? (input.timezone ?? null) : null,
    p_internal_note:
      input.mode === "insert" ? (input.internalNote ?? null) : null,
  })
  if (error) {
    throw new Error(
      `[appointment-write] serialized write failed for shop ${shopId}: ${error.message}`
    )
  }
  const result = data as
    | {
        status?: string
        id?: string
        conflict_ids?: string[]
      }
    | null
  if (result?.status === "inserted" || result?.status === "updated" || result?.status === "exists") {
    if (!result.id) {
      throw new Error(
        `[appointment-write] serialized write returned ${result.status} without an id (shop ${shopId})`
      )
    }
    return { status: result.status, id: result.id }
  }
  if (result?.status === "conflict") {
    return { status: "conflict", conflictIds: result.conflict_ids ?? [] }
  }
  if (result?.status === "not_found") {
    return { status: "not_found" }
  }
  throw new Error(
    `[appointment-write] unexpected serialized-write response for shop ${shopId}: ${JSON.stringify(result)}`
  )
}

const APPOINTMENT_KEY_PREFIX = "appointment:"

/**
 * Extracts the appointment ids a ConflictOverride's `conflicts` keys cover
 * (`conflictKey` format `appointment:<uuid>`). Calendar / hours / capacity
 * keys have no database row to cover and are ignored — only Gradia rows can
 * race into the serialized write.
 */
export function coveredAppointmentIds(conflictKeys: string[]): string[] {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const out: string[] = []
  for (const key of conflictKeys) {
    if (!key.startsWith(APPOINTMENT_KEY_PREFIX)) continue
    const id = key.slice(APPOINTMENT_KEY_PREFIX.length)
    if (UUID_RE.test(id)) out.push(id)
  }
  return out
}
