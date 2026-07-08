/**
 * Vehicles accessor — the single code path to the `vehicles` table (CRM C1).
 * One customer, many vehicles; dedupe within a customer is year+make+model
 * (the C7 rule), so a re-parsed "2021 Tesla Model 3" fills the existing row
 * instead of forking it.
 *
 * WRITE-THROUGH-DEPRECATED (overnight run 2026-07-08): the flat
 * customer/lead vehicle_make/model/year/color columns keep getting written
 * (upsertCustomerVehicle mirrors to customers.*; lead writers keep their
 * flat insert fields) until a follow-up migration drops them. Two reasons:
 * (1) the founder applies migrations — pre-C1 databases must keep working
 * and must not lose vehicle data captured before the migration runs (the
 * C1 backfill reads the flat columns); (2) readers fall back to the flat
 * columns when the `vehicles` table isn't there yet. New READERS must go
 * through this module — never query the flat columns directly.
 *
 * Every function here tolerates the C1 migration being absent: failures
 * log and degrade (empty map / null id), they never throw into a caller's
 * critical path — except customerIdsWithVehicle, whose callers handle the
 * pre-migration fallback themselves.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { ParsedVehicle } from "@/lib/vehicle"
import type { VehicleRow } from "@/lib/types/database"

export type VehicleLite = Pick<
  VehicleRow,
  "id" | "customer_id" | "year" | "make" | "model" | "color" | "size_class"
>

const LITE_COLUMNS = "id, customer_id, year, make, model, color, size_class"

/** "White Tesla Model 3" / "2021 Tesla Model 3" — display order for cards. */
export function describeVehicle(
  v: Pick<VehicleLite, "year" | "make" | "model" | "color"> | null | undefined
): string | null {
  if (!v) return null
  return (
    [v.color ?? v.year, v.make, v.model].filter(Boolean).join(" ").trim() ||
    null
  )
}

/**
 * All vehicles for a set of customers, oldest first (index 0 = the primary
 * vehicle for one-line displays). One query, shop-scoped.
 */
export async function vehiclesByCustomerIds(
  supabase: SupabaseClient,
  shopId: string,
  customerIds: string[]
): Promise<Map<string, VehicleLite[]>> {
  const map = new Map<string, VehicleLite[]>()
  const ids = customerIds.filter(Boolean)
  if (ids.length === 0) return map
  const { data, error } = await supabase
    .from("vehicles")
    .select(LITE_COLUMNS)
    .eq("shop_id", shopId)
    .in("customer_id", ids)
    .order("created_at", { ascending: true })
  if (error) {
    console.error("[vehicles] lookup failed:", error)
    return map
  }
  for (const v of (data as VehicleLite[] | null) ?? []) {
    const list = map.get(v.customer_id) ?? []
    list.push(v)
    map.set(v.customer_id, list)
  }
  return map
}

/** The customer's primary (oldest) vehicle, or null. */
export async function getPrimaryVehicle(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string
): Promise<VehicleLite | null> {
  const map = await vehiclesByCustomerIds(supabase, shopId, [customerId])
  return map.get(customerId)?.[0] ?? null
}

function sameText(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** C7 dedupe rule: fields match when equal, and a missing side is a wildcard. */
function matchesExisting(existing: VehicleLite, v: ParsedVehicle): boolean {
  if (!sameText(existing.make, v.make)) return false
  if (existing.model && v.model && !sameText(existing.model, v.model)) {
    return false
  }
  if (existing.year != null && v.year != null && existing.year !== v.year) {
    return false
  }
  return true
}

/**
 * Find-or-create a customer's vehicle from a parsed car string. Reuses (and
 * back-fills the empty fields of) an existing row that matches on
 * year+make+model; creates a new row for a genuinely different vehicle.
 * Never overwrites a field the row already has. Returns the vehicle id, or
 * null when the parse carried nothing usable. Best-effort — logs, never throws.
 */
export async function upsertCustomerVehicle(
  supabase: SupabaseClient,
  shopId: string,
  customerId: string,
  v: ParsedVehicle,
  opts: {
    /** Stamp import provenance on rows this call CREATES (undo support —
     *  filled-in fields on existing rows are not stamped). */
    importJobId?: string | null
  } = {}
): Promise<string | null> {
  if (!v.make && !v.model && !v.year && !v.color) return null

  // Write-through to the deprecated flat columns (fill-if-empty — the exact
  // pre-C1 writer semantics) so a not-yet-migrated DB loses nothing and the
  // C1 backfill stays correct. Remove with the column-drop migration.
  if (v.make) {
    const { error: flatErr } = await supabase
      .from("customers")
      .update({
        vehicle_make: v.make,
        vehicle_model: v.model,
        vehicle_year: v.year,
        vehicle_color: v.color,
      })
      .eq("id", customerId)
      .eq("shop_id", shopId)
      .is("vehicle_make", null)
    if (flatErr) console.error("[vehicles] flat write-through failed:", flatErr)
  }

  const byCustomer = await vehiclesByCustomerIds(supabase, shopId, [
    customerId,
  ])
  const existing = byCustomer.get(customerId) ?? []

  // A make-less parse (e.g. just "black") can't identify a vehicle — attach
  // to the primary vehicle's blanks if there is one, else create nothing.
  const match = v.make
    ? existing.find((e) => matchesExisting(e, v))
    : existing[0]

  if (match) {
    const fill: Record<string, unknown> = {}
    if (!match.make && v.make) fill.make = v.make
    if (!match.model && v.model) fill.model = v.model
    if (match.year == null && v.year != null) fill.year = v.year
    if (!match.color && v.color) fill.color = v.color
    if (Object.keys(fill).length > 0) {
      const { error } = await supabase
        .from("vehicles")
        .update(fill)
        .eq("id", match.id)
        .eq("shop_id", shopId)
      if (error) console.error("[vehicles] fill failed:", error)
    }
    return match.id
  }

  if (!v.make) return null

  const { data, error } = await supabase
    .from("vehicles")
    .insert({
      shop_id: shopId,
      customer_id: customerId,
      make: v.make,
      model: v.model,
      year: v.year,
      color: v.color,
      import_job_id: opts.importJobId ?? null,
    })
    .select("id")
    .single()
  if (error || !data) {
    console.error("[vehicles] insert failed:", error)
    return null
  }
  return (data as { id: string }).id
}

export type VehicleAudienceFilter = {
  make?: string
  model?: string
  year_min?: number
  year_max?: number
}

export function hasVehicleFilter(f: VehicleAudienceFilter): boolean {
  return Boolean(
    f.make || f.model || f.year_min != null || f.year_max != null
  )
}

/**
 * Customer ids in the shop owning a vehicle that matches the structured
 * filter — powers audience segmentation now that vehicles live in their own
 * table. Read-only; caller applies the ids with `.in(...)`.
 */
export async function customerIdsWithVehicle(
  supabase: SupabaseClient,
  shopId: string,
  f: VehicleAudienceFilter
): Promise<Set<string>> {
  let q = supabase.from("vehicles").select("customer_id").eq("shop_id", shopId)
  if (f.make) q = q.ilike("make", f.make)
  if (f.model) q = q.ilike("model", `%${f.model}%`)
  if (f.year_min != null) q = q.gte("year", f.year_min)
  if (f.year_max != null) q = q.lte("year", f.year_max)
  const { data, error } = await q.limit(5000)
  if (error) {
    throw new Error(`vehicle audience query failed: ${error.message}`)
  }
  return new Set(
    ((data as { customer_id: string }[] | null) ?? []).map(
      (r) => r.customer_id
    )
  )
}
