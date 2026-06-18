/**
 * Post-approval push into Housecall Pro. Parallel to jobber-push.ts and
 * invoked through the lib/crm-provider.ts seam. Two entry points:
 *   - pushLeadToHousecallPro: called after a lead is approved.
 *     Find-or-creates an HCP customer and mirrors the id onto the local
 *     customer row.
 *   - pushBookingToHousecallPro: called after a booking is approved.
 *     Same customer find-or-create, then a job with the agreed time,
 *     and the job id mirrored onto the appointment.
 *
 * Both are best-effort — HCP failures must not roll back the Gradia-side
 * approval. We log + move on; the operator can manually resync later.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  createJob,
  findOrCreateCustomer,
  getAccessTokenForShop,
  HousecallProError,
  nameToCustomerInput,
  type HousecallProCustomer,
} from "@/lib/housecallpro"
import type { ShopRow } from "@/lib/types/database"

type ShopForToken = Pick<
  ShopRow,
  | "id"
  | "housecallpro_access_token_enc"
  | "housecallpro_refresh_token_enc"
  | "housecallpro_token_expires_at"
>

async function loadShopIfConnected(
  supabase: SupabaseClient,
  shopId: string
): Promise<ShopForToken | null> {
  const { data } = await supabase
    .from("shops")
    .select(
      "id, housecallpro_access_token_enc, housecallpro_refresh_token_enc, housecallpro_token_expires_at"
    )
    .eq("id", shopId)
    .single()
  const shop = (data as ShopForToken | null) ?? null
  if (!shop?.housecallpro_access_token_enc) return null
  return shop
}

async function ensureHousecallProCustomer(input: {
  supabase: SupabaseClient
  shop: ShopForToken
  customerId: string | null
  customerName: string
  phone: string | null
  email: string | null
}): Promise<HousecallProCustomer | null> {
  let accessToken: string
  try {
    accessToken = await getAccessTokenForShop(input.supabase, input.shop)
  } catch (err) {
    console.warn("[housecallpro-push] token unavailable:", err)
    return null
  }

  // If we've already pushed this customer once, reuse the stored id.
  if (input.customerId) {
    const { data } = await input.supabase
      .from("customers")
      .select("housecallpro_customer_id, name")
      .eq("id", input.customerId)
      .maybeSingle()
    const existing = data as {
      housecallpro_customer_id: string | null
      name: string | null
    } | null
    if (existing?.housecallpro_customer_id) {
      return {
        id: existing.housecallpro_customer_id,
        name: existing.name ?? input.customerName,
      }
    }
  }

  const namePieces = nameToCustomerInput(
    input.customerName,
    input.phone || "Unnamed lead"
  )

  let customer: HousecallProCustomer
  try {
    customer = await findOrCreateCustomer({
      accessToken,
      customerInput: {
        firstName: namePieces.firstName,
        lastName: namePieces.lastName,
        company: namePieces.company,
        mobileNumber: input.phone || null,
        email: input.email || null,
      },
    })
  } catch (err) {
    if (err instanceof HousecallProError) {
      console.warn("[housecallpro-push] customer upsert failed:", err.message)
    } else {
      console.warn("[housecallpro-push] customer upsert failed:", err)
    }
    return null
  }

  if (input.customerId) {
    const { error } = await input.supabase
      .from("customers")
      .update({ housecallpro_customer_id: customer.id })
      .eq("id", input.customerId)
    if (error) {
      console.warn("[housecallpro-push] mirror customer_id failed:", error)
    }
  }

  return customer
}

export async function pushLeadToHousecallPro(input: {
  supabase: SupabaseClient
  shopId: string
  customerId: string | null
  customerName: string
  phone: string | null
  email?: string | null
}): Promise<void> {
  const shop = await loadShopIfConnected(input.supabase, input.shopId)
  if (!shop) return
  await ensureHousecallProCustomer({
    supabase: input.supabase,
    shop,
    customerId: input.customerId,
    customerName: input.customerName,
    phone: input.phone,
    email: input.email ?? null,
  })
}

export async function pushBookingToHousecallPro(input: {
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

  const customer = await ensureHousecallProCustomer({
    supabase: input.supabase,
    shop,
    customerId: input.customerId,
    customerName: input.customerName,
    phone: input.phone,
    email: input.email ?? null,
  })
  if (!customer) return

  let accessToken: string
  try {
    accessToken = await getAccessTokenForShop(input.supabase, shop)
  } catch (err) {
    console.warn("[housecallpro-push] token unavailable for job:", err)
    return
  }

  const titlePieces = [
    input.service?.trim()
      ? `${input.service.trim()} — ${input.customerName}`
      : `Detail appointment — ${input.customerName}`,
    input.carInfo ? `Vehicle: ${input.carInfo}` : null,
    `Scheduled via Gradia for ${input.isoStartTime}.`,
  ].filter((s): s is string => Boolean(s))

  let job: { id: string }
  try {
    job = await createJob({
      accessToken,
      jobInput: {
        customerId: customer.id,
        description: titlePieces.join(" "),
        scheduledAt: input.isoStartTime,
      },
    })
  } catch (err) {
    if (err instanceof HousecallProError) {
      console.warn("[housecallpro-push] job create failed:", err.message)
    } else {
      console.warn("[housecallpro-push] job create failed:", err)
    }
    return
  }

  const { error } = await input.supabase
    .from("appointments")
    .update({ housecallpro_job_id: job.id })
    .eq("id", input.appointmentId)
  if (error) {
    console.warn("[housecallpro-push] mirror job_id failed:", error)
  }
}
