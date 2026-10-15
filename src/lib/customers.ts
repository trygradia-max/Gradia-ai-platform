import { normalizeDestination } from "@/lib/contact-destination"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { CustomerRow } from "@/lib/types/database"

export type ChannelIdentifiers = {
  phone?: string | null
  email?: string | null
}

export type CustomerInput = ChannelIdentifiers & {
  name?: string | null
}

export type FindOrCreateResult =
  | { ok: true; customer: CustomerRow; created: boolean }
  | { ok: false; error: string }

export function normalizePhone(raw: string | null | undefined): string | null {
  return raw ? normalizeDestination("sms",raw) : null
}
export function normalizeEmail(raw: string | null | undefined): string | null {
  return raw ? normalizeDestination("email",raw) : null
}

type NormalizedIdentifiers = {
  phone: string | null
  email: string | null
}

function normalizeIdentifiers(input: ChannelIdentifiers): NormalizedIdentifiers {
  return {
    phone: normalizePhone(input.phone),
    email: normalizeEmail(input.email),
  }
}

function buildOrFilter(ids: NormalizedIdentifiers): string | null {
  const parts: string[] = []
  if (ids.phone) parts.push(`phone_canonical.eq.${ids.phone}`)
  if (ids.email) parts.push(`email_canonical.eq.${ids.email}`)
  return parts.length > 0 ? parts.join(",") : null
}

/**
 * Lookup-only counterpart to findOrCreateCustomer. Returns one unambiguous
 * matching record or null. Use this from voice / email / SMS handlers when
 * recalling history — we don't want to create empty customer rows during
 * a "do we know this caller?" check.
 */
export async function findCustomerByChannel(
  supabase: SupabaseClient,
  shopId: string,
  input: ChannelIdentifiers
): Promise<CustomerRow | null> {
  const ids = normalizeIdentifiers(input)
  const orFilter = buildOrFilter(ids)
  if (!orFilter) return null

  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("shop_id", shopId)
    .or(orFilter)
    .order("created_at", { ascending: true })
    .maybeSingle()

  if (error) {
    return null
  }
  return (data as CustomerRow | null) ?? null
}

/** Resolve canonical identifiers without silently merging conflicting identities. */
export async function findOrCreateCustomer(
  supabase: SupabaseClient,
  shopId: string,
  input: CustomerInput
): Promise<FindOrCreateResult> {
  const ids = normalizeIdentifiers(input)
  const orFilter = buildOrFilter(ids)
  if ((input.phone && !ids.phone) || (input.email && !ids.email)) return {ok:false,error:"Invalid or ambiguous customer destination."}

  if (!orFilter) {
    return {
      ok: false,
      error: "At least one identifier (phone or email) is required.",
    }
  }

  const { data: matches, error: lookupErr } = await supabase
    .from("customers")
    .select("*")
    .eq("shop_id", shopId)
    .or(orFilter)
    .order("created_at", { ascending: true })

  if (lookupErr) {
    return { ok: false, error: lookupErr.message }
  }

  if (matches && matches.length > 1) return {ok:false,error:"Conflicting customer identities require review."}
  if (matches && matches.length === 1) {
    const target = matches[0] as CustomerRow
    if ((ids.phone && target.phone && normalizePhone(target.phone)!==ids.phone) || (ids.email && target.email && normalizeEmail(target.email)!==ids.email)) return {ok:false,error:"Destination conflicts with the identified customer; review required."}

    const updates: Partial<CustomerRow> = {}
    const cleanName = input.name?.trim()
    if (!target.name && cleanName) updates.name = cleanName
    if (!target.phone && ids.phone) updates.phone = ids.phone
    if (!target.email && ids.email) updates.email = ids.email

    if (Object.keys(updates).length === 0) {
      return { ok: true, customer: target, created: false }
    }

    const { data: updated, error: updateErr } = await supabase
      .from("customers")
      .update(updates)
      .eq("id", target.id)
      .eq("shop_id", shopId)
      .select("*")
      .single()

    if (updateErr) {
      return {ok:false,error:"Customer identifier update failed; review required."}
    }

    return { ok: true, customer: updated as CustomerRow, created: false }
  }

  const cleanName = input.name?.trim() || null
  const { data: created, error: insertErr } = await supabase
    .from("customers")
    .insert({
      shop_id: shopId,
      name: cleanName,
      phone: ids.phone,
      email: ids.email,
    })
    .select("*")
    .single()

  if (insertErr) {
    // Race: a concurrent insert won. Re-lookup and adopt the winner.
    const { data: race } = await supabase
      .from("customers")
      .select("*")
      .eq("shop_id", shopId)
      .or(orFilter)
      .order("created_at", { ascending: true })

    if (race && race.length === 1) {
      const candidate=race[0] as CustomerRow
      if ((ids.phone && normalizePhone(candidate.phone)!==ids.phone) || (ids.email && normalizeEmail(candidate.email)!==ids.email)) return {ok:false,error:"Concurrent identifier conflict requires review."}
      return { ok: true, customer: race[0] as CustomerRow, created: false }
    }
    return { ok: false, error: insertErr.message }
  }

  return { ok: true, customer: created as CustomerRow, created: true }
}
