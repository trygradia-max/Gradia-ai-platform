import { createHash } from "node:crypto"

import { forShop } from "@/lib/supabase/for-shop"
import { normalizeDestination } from "@/lib/contact-destination"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { ExtractorOutput } from "./extraction-schema"

/**
 * Existing customer / vehicle resolution for Call Copilot proposals (PR E).
 *
 * Read-only, tenant-scoped through `forShop`, and keyed on the SAME canonical identifiers the CRM
 * already enforces (`phone_canonical` / `email_canonical`). Nothing is created or linked here: the
 * result is a snapshot the planner turns into proposals, and the database re-reads the CRM row itself
 * when a proposal is recorded. Identity is never inferred from a model or a fuzzy score: an exact
 * canonical identifier match is the only thing that links, several matches are ambiguity, and a name
 * alone is only ever listed as candidates for a human.
 */

export type CrmCustomer = {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  phoneCanonical: string | null
  emailCanonical: string | null
  updatedAt: string
}
export type CrmVehicle = {
  id: string
  customerId: string
  make: string | null
  model: string | null
  year: number | null
  color: string | null
  updatedAt: string
}
export type CrmSnapshot = {
  byPhone: Record<string, CrmCustomer[]>
  byEmail: Record<string, CrmCustomer[]>
  /** Exact (case-insensitive) name candidates, only collected for a customer heard WITHOUT an identifier. */
  byName: Record<string, CrmCustomer[]>
  /** The customer this call is already linked to, as supplied by trusted server code. */
  known: CrmCustomer | null
  vehiclesByCustomer: Record<string, CrmVehicle[]>
}

export const emptyCrmSnapshot = (): CrmSnapshot => ({ byPhone: {}, byEmail: {}, byName: {}, known: null, vehiclesByCustomer: {} })

type CustomerRow = {
  id: string; name: string | null; phone: string | null; email: string | null
  phone_canonical: string | null; email_canonical: string | null; updated_at: string
}
type VehicleRow = {
  id: string; customer_id: string; make: string | null; model: string | null
  year: number | null; color: string | null; updated_at: string
}
const CUSTOMER_COLUMNS = "id,name,phone,email,phone_canonical,email_canonical,updated_at"

const toCustomer = (r: CustomerRow): CrmCustomer => ({
  id: r.id, name: r.name, phone: r.phone, email: r.email,
  phoneCanonical: r.phone_canonical, emailCanonical: r.email_canonical, updatedAt: r.updated_at,
})
const toVehicle = (r: VehicleRow): CrmVehicle => ({
  id: r.id, customerId: r.customer_id, make: r.make, model: r.model, year: r.year, color: r.color, updatedAt: r.updated_at,
})

export const canonicalHeardPhone = (v: string): string | null => normalizeDestination("sms", v)
export const canonicalHeardEmail = (v: string): string | null => normalizeDestination("email", v)
export const nameKey = (v: string): string => v.trim().replace(/\s+/g, " ").toLowerCase()

/** ILIKE metacharacters are data, not wildcards. */
const escapeLike = (v: string): string => v.replace(/[\\%_]/g, (c) => `\\${c}`)

export async function loadCrmSnapshot(
  db: SupabaseClient,
  input: { shopId: string; output: ExtractorOutput; knownCustomerId?: string | null },
): Promise<CrmSnapshot> {
  const scoped = forShop(db, input.shopId)
  const snap = emptyCrmSnapshot()
  const phones = new Set<string>()
  const emails = new Set<string>()
  const names = new Set<string>()
  for (const p of input.output.proposals) {
    if (p.kind !== "customer") continue
    const phone = p.phone ? canonicalHeardPhone(p.phone.value) : null
    const email = p.email ? canonicalHeardEmail(p.email.value) : null
    if (phone) phones.add(phone)
    if (email) emails.add(email)
    if (!phone && !email && p.name) names.add(p.name.value)
  }
  const fail = (what: string, code: string | undefined) => new Error(`CRM lookup failed: ${what} (${code ?? "unknown"}).`)

  if (phones.size) {
    const { data, error } = await scoped.select("customers", CUSTOMER_COLUMNS).in("phone_canonical", [...phones])
    if (error) throw fail("customers by phone", error.code)
    for (const r of (data ?? []) as unknown as CustomerRow[]) (snap.byPhone[r.phone_canonical ?? ""] ??= []).push(toCustomer(r))
  }
  if (emails.size) {
    const { data, error } = await scoped.select("customers", CUSTOMER_COLUMNS).in("email_canonical", [...emails])
    if (error) throw fail("customers by email", error.code)
    for (const r of (data ?? []) as unknown as CustomerRow[]) (snap.byEmail[r.email_canonical ?? ""] ??= []).push(toCustomer(r))
  }
  for (const n of names) {
    const { data, error } = await scoped.select("customers", CUSTOMER_COLUMNS).ilike("name", escapeLike(n.trim())).limit(5)
    if (error) throw fail("customers by name", error.code)
    snap.byName[nameKey(n)] = ((data ?? []) as unknown as CustomerRow[]).map(toCustomer)
  }

  const wanted = new Set<string>()
  if (input.knownCustomerId) {
    const { data, error } = await scoped.select("customers", CUSTOMER_COLUMNS).eq("id", input.knownCustomerId).maybeSingle()
    if (error) throw fail("known customer", error.code)
    // A forged or cross-shop id finds nothing and simply leaves the call unlinked.
    if (data) {
      snap.known = toCustomer(data as unknown as CustomerRow)
      wanted.add(snap.known.id)
    }
  }
  for (const group of [snap.byPhone, snap.byEmail]) {
    for (const list of Object.values(group)) if (list.length === 1) wanted.add(list[0].id)
  }
  if (wanted.size) {
    const { data, error } = await scoped
      .select("vehicles", "id,customer_id,make,model,year,color,updated_at")
      .in("customer_id", [...wanted])
    if (error) throw fail("vehicles", error.code)
    for (const r of (data ?? []) as unknown as VehicleRow[]) (snap.vehiclesByCustomer[r.customer_id] ??= []).push(toVehicle(r))
  }
  return snap
}

/**
 * Stable digest of the CRM facts a plan was built from. It is part of the extraction run identity, so
 * the same evidence planned against changed CRM state (or a different shop timezone) is a NEW run, while an identical replay is not.
 */
export function crmContextDigest(snap: CrmSnapshot, shop: { timezone?: string | null } = {}): string {
  const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))
  const view = (c: CrmCustomer) => [c.id, c.name, c.phoneCanonical, c.emailCanonical, c.updatedAt]
  const norm = {
    byPhone: Object.keys(snap.byPhone).sort().map((k) => [k, sortById(snap.byPhone[k]).map(view)]),
    byEmail: Object.keys(snap.byEmail).sort().map((k) => [k, sortById(snap.byEmail[k]).map(view)]),
    byName: Object.keys(snap.byName).sort().map((k) => [k, sortById(snap.byName[k]).map(view)]),
    known: snap.known ? view(snap.known) : null,
    vehicles: Object.keys(snap.vehiclesByCustomer).sort().map((k) => [
      k, sortById(snap.vehiclesByCustomer[k]).map((v) => [v.id, v.make, v.model, v.year, v.color, v.updatedAt]),
    ]),
  }
  // The shop's timezone decides whether an appointment start is verifiable, so it is part of what a plan was built from.
  return createHash("sha256").update(JSON.stringify(["crm-context-v2", norm, shop.timezone ?? null])).digest("hex")
}
