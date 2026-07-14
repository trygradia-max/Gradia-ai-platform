/**
 * Deterministic person lookup (fix-pass 2026-07-13, P0). The production
 * failure: "find mike" hit vector memory only, and a lead with no
 * interactions is invisible there — the agent then invented a connectivity
 * excuse for what was simply a miss. This module is the fix, in code
 * (locked principle #2):
 *
 *   1. SQL-first: ILIKE name + digit-fragment phone across BOTH leads and
 *      customers, shop-scoped, vehicles joined. Vector memory is a
 *      secondary signal for WHAT someone said — never the only path to WHO.
 *   2. Honest outcomes, decided by code: 0 hits = a miss that says it's a
 *      miss (and offers the create), 1 hit = proceed, >1 = disambiguate
 *      with facts on file. NEVER ask for a phone number when a unique name
 *      match exists.
 *
 * Matching/merging/reply-shaping is pure — golden-fixture tested.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { describeVehicle, vehiclesByCustomerIds } from "@/lib/vehicles"

export type PersonRecord = {
  source: "lead" | "customer"
  id: string
  /** For leads: the linked customer id when one exists (dedupe key). */
  customerId: string | null
  name: string | null
  phone: string | null
  email: string | null
  vehicle: string | null
  /** Lead-side context when present ("quote_sent", pin notes). */
  stage: string | null
  note: string | null
  createdAt: string | null
}

export type PersonMatch = PersonRecord & {
  matchedOn: "name" | "phone" | "both"
}

/** Last-10 digit fragment for phone matching; null when too short. */
export function phoneFragment(query: string): string | null {
  const digits = query.replace(/\D/g, "")
  return digits.length >= 4 ? digits.slice(-10) : null
}

function normName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * Pure matcher — mirrors the SQL ILIKE semantics so fixtures and the DB
 * wrapper can't drift: every query token must appear in the name (substring,
 * case-insensitive), OR the digit fragment must appear in the phone.
 */
export function matchPeople(query: string, people: PersonRecord[]): PersonMatch[] {
  const q = normName(query)
  const tokens = q.split(" ").filter(Boolean)
  const fragment = phoneFragment(query)

  const out: PersonMatch[] = []
  for (const p of people) {
    const name = normName(p.name)
    const nameHit =
      tokens.length > 0 && name.length > 0 && tokens.every((t) => name.includes(t))
    const phoneDigits = (p.phone ?? "").replace(/\D/g, "")
    const phoneHit = Boolean(fragment && phoneDigits.includes(fragment))
    if (!nameHit && !phoneHit) continue
    out.push({
      ...p,
      matchedOn: nameHit && phoneHit ? "both" : nameHit ? "name" : "phone",
    })
  }
  return dedupePeople(out)
}

/**
 * A lead and its linked customer are ONE person: collapse on customer id
 * (or a phone key), preferring the record with the most facts and carrying
 * the lead's stage/note context over.
 */
export function dedupePeople(matches: PersonMatch[]): PersonMatch[] {
  const byKey = new Map<string, PersonMatch>()
  for (const m of matches) {
    const key =
      m.customerId ??
      (m.source === "customer" ? m.id : null) ??
      `phone:${(m.phone ?? "").replace(/\D/g, "").slice(-10) || m.id}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, m)
      continue
    }
    // Merge: keep the customer identity, enrich with lead context.
    const customerSide = existing.source === "customer" ? existing : m
    const leadSide = existing.source === "lead" ? existing : m
    byKey.set(key, {
      ...customerSide,
      vehicle: customerSide.vehicle ?? leadSide.vehicle,
      email: customerSide.email ?? leadSide.email,
      stage: leadSide.stage ?? customerSide.stage,
      note: leadSide.note ?? customerSide.note,
      matchedOn: existing.matchedOn,
    })
  }
  return [...byKey.values()]
}

/** A short distinguishing line per person, from facts on file only. */
export function describeMatch(m: PersonMatch): string {
  const bits = [
    m.vehicle,
    m.stage ? `pipeline: ${m.stage.replace(/_/g, " ")}` : null,
    m.phone ? `…${m.phone.replace(/\D/g, "").slice(-4)}` : null,
  ].filter(Boolean)
  return `${m.name ?? "Unnamed"}${bits.length ? ` (${bits.join(" · ")})` : ""}`
}

// ---------- DB wrapper (read-only — lives behind the BI tool) ----------

function safeQuery(q: string): string {
  return q.replace(/[%,()]/g, "").trim()
}

/**
 * SQL-first lookup across BOTH tables, shop-scoped. Over-fetches with ILIKE
 * then runs the same pure matcher the fixtures lock, so DB and fixture
 * behavior can't drift. Read-only.
 */
export async function findPeopleInCrm(
  supabase: SupabaseClient,
  shopId: string,
  rawQuery: string
): Promise<PersonMatch[]> {
  const q = safeQuery(rawQuery)
  if (!q) return []
  const fragment = phoneFragment(q)

  const leadOrs = [`customer_name.ilike.%${q}%`]
  const customerOrs = [`name.ilike.%${q}%`]
  if (fragment) {
    leadOrs.push(`phone.ilike.%${fragment}%`)
    customerOrs.push(`phone.ilike.%${fragment}%`)
  }
  if (q.includes("@")) customerOrs.push(`email.eq.${q}`)

  const [leadsRes, customersRes] = await Promise.all([
    supabase
      .from("leads")
      .select("id, customer_id, customer_name, phone, car_info, status, pin_notes, created_at")
      .eq("shop_id", shopId)
      .or(leadOrs.join(","))
      .limit(10),
    supabase
      .from("customers")
      .select("id, name, phone, email, created_at")
      .eq("shop_id", shopId)
      .or(customerOrs.join(","))
      .limit(10),
  ])

  type LeadHit = {
    id: string
    customer_id: string | null
    customer_name: string
    phone: string
    car_info: string | null
    status: string
    pin_notes: string | null
    created_at: string
    stage?: string | null
  }
  type CustomerHit = {
    id: string
    name: string | null
    phone: string | null
    email: string | null
    created_at: string
  }
  const leadHits = (leadsRes.data as LeadHit[] | null) ?? []
  const customerHits = (customersRes.data as CustomerHit[] | null) ?? []

  // Vehicle lines via the accessor (flat car_info as the lead fallback).
  const customerIds = [
    ...new Set(
      [...customerHits.map((c) => c.id), ...leadHits.map((l) => l.customer_id)].filter(
        (x): x is string => Boolean(x)
      )
    ),
  ]
  const vehicles = await vehiclesByCustomerIds(supabase, shopId, customerIds)

  const records: PersonRecord[] = [
    ...customerHits.map((c) => ({
      source: "customer" as const,
      id: c.id,
      customerId: null,
      name: c.name,
      phone: c.phone,
      email: c.email,
      vehicle: describeVehicle(vehicles.get(c.id)?.[0]),
      stage: null,
      note: null,
      createdAt: c.created_at,
    })),
    ...leadHits.map((l) => ({
      source: "lead" as const,
      id: l.id,
      customerId: l.customer_id,
      name: l.customer_name,
      phone: l.phone,
      email: null,
      vehicle:
        (l.customer_id ? describeVehicle(vehicles.get(l.customer_id)?.[0]) : null) ??
        l.car_info,
      stage: l.stage ?? l.status,
      note: l.pin_notes,
      createdAt: l.created_at,
    })),
  ]

  return matchPeople(rawQuery, records)
}

export type LookupOutcome =
  | { outcome: "none"; say: string }
  | { outcome: "one"; match: PersonMatch; say: string }
  | { outcome: "many"; matches: PersonMatch[]; say: string }

/**
 * The reply contract, decided by CODE (never fabricated by the model):
 * misses are honest and end in the one useful next action; collisions
 * disambiguate with facts; a unique hit never triggers a request for
 * information already on file.
 */
export function buildLookupOutcome(
  query: string,
  matches: PersonMatch[]
): LookupOutcome {
  if (matches.length === 0) {
    return {
      outcome: "none",
      say: `I don't see anyone matching "${query.trim()}" in the CRM yet — want me to create the lead?`,
    }
  }
  if (matches.length === 1) {
    const m = matches[0]
    return {
      outcome: "one",
      match: m,
      say: `Found ${describeMatch(m)}.`,
    }
  }
  const listed = matches
    .slice(0, 4)
    .map((m) => describeMatch(m))
    .join("; ")
  return {
    outcome: "many",
    matches,
    say: `A few people match "${query.trim()}" — which one: ${listed}?`,
  }
}
