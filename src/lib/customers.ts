import type { SupabaseClient } from "@supabase/supabase-js"

import type { CustomerRow } from "@/lib/types/database"

export type ChannelIdentifiers = {
  phone?: string | null
  email?: string | null
  instagramHandle?: string | null
  facebookId?: string | null
}

export type CustomerInput = ChannelIdentifiers & {
  name?: string | null
}

export type FindOrCreateResult =
  | { ok: true; customer: CustomerRow; created: boolean }
  | { ok: false; error: string }

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const digits = trimmed.replace(/\D/g, "")
  if (!digits) return null
  return trimmed.startsWith("+") ? `+${digits}` : digits
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed || null
}

export function normalizeInstagramHandle(
  raw: string | null | undefined
): string | null {
  if (!raw) return null
  const trimmed = raw.trim().replace(/^@/, "").toLowerCase()
  return trimmed || null
}

export function normalizeFacebookId(
  raw: string | null | undefined
): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  return trimmed || null
}

type NormalizedIdentifiers = {
  phone: string | null
  email: string | null
  instagram_handle: string | null
  facebook_id: string | null
}

function normalizeIdentifiers(input: ChannelIdentifiers): NormalizedIdentifiers {
  return {
    phone: normalizePhone(input.phone),
    email: normalizeEmail(input.email),
    instagram_handle: normalizeInstagramHandle(input.instagramHandle),
    facebook_id: normalizeFacebookId(input.facebookId),
  }
}

function buildOrFilter(ids: NormalizedIdentifiers): string | null {
  const parts: string[] = []
  if (ids.phone) parts.push(`phone.eq.${ids.phone}`)
  if (ids.email) parts.push(`email.eq.${ids.email}`)
  if (ids.instagram_handle)
    parts.push(`instagram_handle.eq.${ids.instagram_handle}`)
  if (ids.facebook_id) parts.push(`facebook_id.eq.${ids.facebook_id}`)
  return parts.length > 0 ? parts.join(",") : null
}

/**
 * Lookup-only counterpart to findOrCreateCustomer. Returns the oldest
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
    .limit(1)
    .maybeSingle()

  if (error) {
    return null
  }
  return (data as CustomerRow | null) ?? null
}

/**
 * Resolves a customer for the given shop, creating one if no existing row
 * matches any of the provided channel identifiers. The match wins by oldest
 * created_at, so concurrent inserts deterministically converge on one record.
 *
 * Conflict policy: if a new identifier we'd add is already in use by a
 * different customer in this shop, we skip filling that field on the
 * resolved record and return what we have. Manual merge handles cross-record
 * dedup later — we never auto-merge two customers.
 */
export async function findOrCreateCustomer(
  supabase: SupabaseClient,
  shopId: string,
  input: CustomerInput
): Promise<FindOrCreateResult> {
  const ids = normalizeIdentifiers(input)
  const orFilter = buildOrFilter(ids)

  if (!orFilter) {
    return {
      ok: false,
      error:
        "At least one identifier (phone, email, instagram, or facebook) is required.",
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

  if (matches && matches.length > 0) {
    const target = matches[0] as CustomerRow

    const updates: Partial<CustomerRow> = {}
    const cleanName = input.name?.trim()
    if (!target.name && cleanName) updates.name = cleanName
    if (!target.phone && ids.phone) updates.phone = ids.phone
    if (!target.email && ids.email) updates.email = ids.email
    if (!target.instagram_handle && ids.instagram_handle)
      updates.instagram_handle = ids.instagram_handle
    if (!target.facebook_id && ids.facebook_id)
      updates.facebook_id = ids.facebook_id

    if (Object.keys(updates).length === 0) {
      return { ok: true, customer: target, created: false }
    }

    const { data: updated, error: updateErr } = await supabase
      .from("customers")
      .update(updates)
      .eq("id", target.id)
      .select("*")
      .single()

    if (updateErr) {
      // Likely a unique-violation: an identifier we tried to add is already
      // bound to another customer. Return the original record un-updated so
      // the caller still gets a valid customer to attach.
      console.warn(
        "[customers] partial update conflict, returning existing record:",
        updateErr.message
      )
      return { ok: true, customer: target, created: false }
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
      instagram_handle: ids.instagram_handle,
      facebook_id: ids.facebook_id,
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
      .limit(1)

    if (race && race.length > 0) {
      return { ok: true, customer: race[0] as CustomerRow, created: false }
    }
    return { ok: false, error: insertErr.message }
  }

  return { ok: true, customer: created as CustomerRow, created: true }
}
