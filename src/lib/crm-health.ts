/**
 * CRM data-quality engine — the "clean up your CRM" win when an owner connects
 * or imports. Surfaces the two things that make messy data hurt an agent:
 *   1. Duplicates — the same person as several records (the "5 Sarahs" problem).
 *   2. Gaps — no way to reach them (no phone/email) or no vehicle on file, so
 *      segmentation and outreach silently miss them.
 *
 * Read-only + pure helpers (testable). Acting on findings (merge, fill) lives in
 * the cleanup server actions.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { CustomerRow } from "@/lib/types/database"

export type CustomerLite = Pick<
  CustomerRow,
  | "id"
  | "name"
  | "phone"
  | "email"
  | "vehicle_make"
  | "vehicle_model"
  | "vehicle_color"
  | "last_visit_at"
>

const LITE_COLUMNS =
  "id, name, phone, email, vehicle_make, vehicle_model, vehicle_color, last_visit_at"

export type DuplicateCluster = {
  /** Normalized name the cluster groups on. */
  key: string
  members: CustomerLite[]
}

export type CrmHealth = {
  total: number
  missingContact: CustomerLite[]
  missingPhone: number
  missingEmail: number
  missingVehicle: number
  duplicateClusters: DuplicateCluster[]
}

/** Lowercase, collapse whitespace, drop punctuation — "Sarah J." ~ "sarah j". */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Groups records that share a normalized name into potential-duplicate clusters
 * (the owner confirms before merging). Records with no usable name are skipped.
 * Returns clusters of 2+, largest first.
 */
export function findDuplicateClusters(
  customers: CustomerLite[]
): DuplicateCluster[] {
  const groups = new Map<string, CustomerLite[]>()
  for (const c of customers) {
    const key = normalizeName(c.name)
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(c)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({ key, members }))
    .sort((a, b) => b.members.length - a.members.length)
}

/** Full health snapshot for a shop's CRM. */
export async function getCrmHealth(
  supabase: SupabaseClient,
  shopId: string
): Promise<CrmHealth> {
  const { data, error } = await supabase
    .from("customers")
    .select(LITE_COLUMNS)
    .eq("shop_id", shopId)
  if (error) {
    console.error("[crm-health] query failed:", error)
    return {
      total: 0,
      missingContact: [],
      missingPhone: 0,
      missingEmail: 0,
      missingVehicle: 0,
      duplicateClusters: [],
    }
  }
  const customers = (data as CustomerLite[] | null) ?? []
  const has = (v: string | null) => Boolean(v && v.trim())

  return {
    total: customers.length,
    missingContact: customers.filter((c) => !has(c.phone) && !has(c.email)),
    missingPhone: customers.filter((c) => !has(c.phone)).length,
    missingEmail: customers.filter((c) => !has(c.email)).length,
    missingVehicle: customers.filter((c) => !has(c.vehicle_make)).length,
    duplicateClusters: findDuplicateClusters(customers),
  }
}
