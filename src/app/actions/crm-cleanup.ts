"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getCrmHealth, type CrmHealth } from "@/lib/crm-health"
import { upsertCustomerVehicle } from "@/lib/vehicles"
import { requireShop, requireUser } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { CustomerRow } from "@/lib/types/database"

export type CleanupResult = { ok: true } | { ok: false; error: string }

export async function getCrmHealthForCurrentShop(): Promise<CrmHealth> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  return getCrmHealth(supabase, shop.id)
}

export type CrmCleanupState = { health: CrmHealth; justConnected: boolean }

/** Health + whether a CRM was just connected (drives the Home auto-pop). */
export async function getCrmCleanupState(): Promise<CrmCleanupState> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("settings")
    .eq("id", shop.id)
    .single()
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {}
  const health = await getCrmHealth(supabase, shop.id)
  return { health, justConnected: settings.crm_just_connected === true }
}

/** Clears the just-connected flag once the owner has dealt with the cleanup. */
export async function dismissCrmCleanup(): Promise<CleanupResult> {
  await requireUser()
  const shop = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase.from("shops").select("settings").eq("id", shop.id).single()
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {}
  const { error } = await supabase
    .from("shops")
    .update({ settings: { ...settings, crm_just_connected: false } })
    .eq("id", shop.id)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard")
  return { ok: true }
}

/** Fields a merge carries from the duplicate into the primary when missing.
 *  Flat vehicle_* fields stay for write-through (deprecated — see
 *  lib/vehicles.ts); the vehicles-table rows re-point to the primary. */
const FILLABLE = [
  "name",
  "phone",
  "email",
  "vehicle_make",
  "vehicle_model",
  "vehicle_year",
  "vehicle_color",
  "last_visit_at",
  "marketing_consent_at",
  "marketing_consent_source",
] as const

/**
 * Merge a duplicate customer into the primary: re-point their leads /
 * interactions / appointments, delete the duplicate, then backfill any field
 * the primary was missing. Delete-before-fill avoids the unique (shop, phone/
 * email) index colliding.
 */
export async function mergeCustomers(
  primaryId: string,
  dupeId: string
): Promise<CleanupResult> {
  await requireUser()
  const shop = await requireShop()
  if (primaryId === dupeId) return { ok: false, error: "Pick two different records." }
  const supabase = await createClient()

  const { data } = await supabase
    .from("customers")
    .select("*")
    .eq("shop_id", shop.id)
    .in("id", [primaryId, dupeId])
  const rows = (data as CustomerRow[] | null) ?? []
  const primary = rows.find((r) => r.id === primaryId)
  const dupe = rows.find((r) => r.id === dupeId)
  if (!primary || !dupe) return { ok: false, error: "Couldn't find both records." }

  for (const table of [
    "leads",
    "interactions",
    "appointments",
    "vehicles",
  ] as const) {
    await supabase
      .from(table)
      .update({ customer_id: primaryId })
      .eq("shop_id", shop.id)
      .eq("customer_id", dupeId)
  }

  await supabase.from("customers").delete().eq("shop_id", shop.id).eq("id", dupeId)

  const fill: Record<string, unknown> = {}
  for (const f of FILLABLE) {
    if (!primary[f] && dupe[f]) fill[f] = dupe[f]
  }
  if (Object.keys(fill).length) {
    await supabase.from("customers").update(fill).eq("id", primaryId).eq("shop_id", shop.id)
  }

  revalidatePath("/customers")
  return { ok: true }
}

const updateSchema = z.object({
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  vehicle_make: z.string().trim().max(40).optional(),
  vehicle_model: z.string().trim().max(60).optional(),
  vehicle_color: z.string().trim().max(30).optional(),
})

/** Fill in missing customer details from the cleanup UI. Vehicle fields
 *  land in the `vehicles` table; contact fields on the customer. */
export async function updateCustomerDetails(
  customerId: string,
  fields: z.infer<typeof updateSchema>
): Promise<CleanupResult> {
  await requireUser()
  const shop = await requireShop()
  const parsed = updateSchema.safeParse(fields)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid details." }
  }
  // Flat vehicle_* fields stay in the customer patch (write-through,
  // deprecated); the vehicles table gets the same values via the accessor.
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed.data)) {
    if (typeof v === "string" && v.trim()) patch[k] = v.trim()
  }
  const { vehicle_make, vehicle_model, vehicle_color } = parsed.data
  const vehicle = {
    make: vehicle_make?.trim() || null,
    model: vehicle_model?.trim() || null,
    year: null,
    color: vehicle_color?.trim() || null,
  }
  const hasVehicle = Boolean(vehicle.make || vehicle.model || vehicle.color)
  if (Object.keys(patch).length === 0 && !hasVehicle) {
    return { ok: false, error: "Nothing to update." }
  }

  const supabase = await createClient()
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("customers")
      .update(patch)
      .eq("id", customerId)
      .eq("shop_id", shop.id)
    if (error) return { ok: false, error: error.message }
  }
  if (hasVehicle) {
    await upsertCustomerVehicle(supabase, shop.id, customerId, vehicle)
  }
  revalidatePath("/customers")
  return { ok: true }
}
