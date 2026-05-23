/**
 * Post-approval push into Jobber. Two entry points:
 *   - pushLeadToJobber: called after executeCreateLead succeeds.
 *     Find-or-creates a Jobber client and mirrors the id onto the
 *     local customer row.
 *   - pushBookingToJobber: called after executeBookAppointment
 *     succeeds. Same client find-or-create, then a Request with the
 *     agreed time, and the request id mirrored onto the appointment.
 *
 * Both are best-effort — Jobber failures must not roll back the
 * Gradia-side approval. We log + move on; the operator can manually
 * resync from the customer detail page in a future pass.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  createRequest,
  findOrCreateClient,
  getAccessTokenForShop,
  JobberError,
  nameToClientInput,
  type JobberClient,
} from "@/lib/jobber"
import type { ShopRow } from "@/lib/types/database"

type ShopForToken = Pick<
  ShopRow,
  | "id"
  | "jobber_access_token_enc"
  | "jobber_refresh_token_enc"
  | "jobber_token_expires_at"
>

async function loadShopIfConnected(
  supabase: SupabaseClient,
  shopId: string
): Promise<ShopForToken | null> {
  const { data } = await supabase
    .from("shops")
    .select(
      "id, jobber_access_token_enc, jobber_refresh_token_enc, jobber_token_expires_at"
    )
    .eq("id", shopId)
    .single()
  const shop = (data as ShopForToken | null) ?? null
  if (!shop?.jobber_access_token_enc) return null
  return shop
}

async function ensureJobberClient(input: {
  supabase: SupabaseClient
  shop: ShopForToken
  customerId: string | null
  customerName: string
  phone: string | null
  email: string | null
}): Promise<JobberClient | null> {
  let accessToken: string
  try {
    accessToken = await getAccessTokenForShop(input.supabase, input.shop)
  } catch (err) {
    console.warn("[jobber-push] token unavailable:", err)
    return null
  }

  // If we've already pushed this customer once, reuse the stored id.
  if (input.customerId) {
    const { data } = await input.supabase
      .from("customers")
      .select("jobber_client_id, name")
      .eq("id", input.customerId)
      .maybeSingle()
    const existing = data as {
      jobber_client_id: string | null
      name: string | null
    } | null
    if (existing?.jobber_client_id) {
      return {
        id: existing.jobber_client_id,
        name: existing.name ?? input.customerName,
      }
    }
  }

  const namePieces = nameToClientInput(
    input.customerName,
    input.phone || "Unnamed lead"
  )

  let client: JobberClient
  try {
    client = await findOrCreateClient({
      accessToken,
      clientInput: {
        firstName: namePieces.firstName,
        lastName: namePieces.lastName,
        companyName: namePieces.companyName,
        phone: input.phone || null,
        email: input.email || null,
      },
      fallbackName: input.customerName,
    })
  } catch (err) {
    if (err instanceof JobberError) {
      console.warn("[jobber-push] client upsert failed:", err.message)
    } else {
      console.warn("[jobber-push] client upsert failed:", err)
    }
    return null
  }

  if (input.customerId) {
    const { error } = await input.supabase
      .from("customers")
      .update({ jobber_client_id: client.id })
      .eq("id", input.customerId)
    if (error) {
      console.warn("[jobber-push] mirror client_id failed:", error)
    }
  }

  return client
}

export async function pushLeadToJobber(input: {
  supabase: SupabaseClient
  shopId: string
  customerId: string | null
  customerName: string
  phone: string | null
  email?: string | null
}): Promise<void> {
  const shop = await loadShopIfConnected(input.supabase, input.shopId)
  if (!shop) return
  await ensureJobberClient({
    supabase: input.supabase,
    shop,
    customerId: input.customerId,
    customerName: input.customerName,
    phone: input.phone,
    email: input.email ?? null,
  })
}

export async function pushBookingToJobber(input: {
  supabase: SupabaseClient
  shopId: string
  appointmentId: string
  customerId: string | null
  customerName: string
  phone: string | null
  email?: string | null
  service: string | null
  isoStartTime: string
  carInfo: string | null
}): Promise<void> {
  const shop = await loadShopIfConnected(input.supabase, input.shopId)
  if (!shop) return

  const client = await ensureJobberClient({
    supabase: input.supabase,
    shop,
    customerId: input.customerId,
    customerName: input.customerName,
    phone: input.phone,
    email: input.email ?? null,
  })
  if (!client) return

  let accessToken: string
  try {
    accessToken = await getAccessTokenForShop(input.supabase, shop)
  } catch (err) {
    console.warn("[jobber-push] token unavailable for request:", err)
    return
  }

  const title = input.service?.trim()
    ? `${input.service.trim()} — ${input.customerName}`
    : `Detail appointment — ${input.customerName}`
  const descriptionParts = [
    input.carInfo ? `Vehicle: ${input.carInfo}` : null,
    `Scheduled via Gradia for ${input.isoStartTime}.`,
  ].filter((s): s is string => Boolean(s))

  let request: { id: string }
  try {
    request = await createRequest({
      accessToken,
      requestInput: {
        clientId: client.id,
        title,
        description: descriptionParts.join(" "),
        scheduledAt: input.isoStartTime,
      },
    })
  } catch (err) {
    if (err instanceof JobberError) {
      console.warn("[jobber-push] requestCreate failed:", err.message)
    } else {
      console.warn("[jobber-push] requestCreate failed:", err)
    }
    return
  }

  const { error } = await input.supabase
    .from("appointments")
    .update({ jobber_request_id: request.id })
    .eq("id", input.appointmentId)
  if (error) {
    console.warn("[jobber-push] mirror request_id failed:", error)
  }
}
