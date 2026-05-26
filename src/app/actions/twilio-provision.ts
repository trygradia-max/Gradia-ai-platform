"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

import {
  findIncomingPhoneNumberSid,
  provisionPhoneNumber,
  releasePhoneNumber,
  resolveTwilioCredentials,
  searchAvailableNumbers,
  type TwilioAvailableNumber,
} from "@/lib/twilio"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import type { ShopRow } from "@/lib/types/database"

async function resolveOrigin(): Promise<string> {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

async function loadShop(): Promise<ShopRow | null> {
  const shopCtx = await requireShop()
  const supabase = await createClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopCtx.id)
    .single()
  return (data as ShopRow | null) ?? null
}

export type SearchTwilioNumbersResult =
  | { ok: true; numbers: TwilioAvailableNumber[] }
  | { ok: false; error: string }

/**
 * Surfaces a handful of available local numbers from Twilio's pool —
 * optionally narrowed by area code. Runs against Gradia's master
 * Twilio account by default, or the shop's BYO creds when present.
 *
 * Read-only on Twilio's side. Cheap and safe to call repeatedly.
 */
export async function searchTwilioNumbers(input: {
  areaCode?: string
  country?: string
}): Promise<SearchTwilioNumbersResult> {
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }

  const creds = resolveTwilioCredentials(shop)
  if (!creds) {
    return {
      ok: false,
      error: "Twilio isn't configured on the server yet.",
    }
  }

  try {
    const numbers = await searchAvailableNumbers({
      country: input.country?.trim() || "US",
      areaCode: input.areaCode?.trim() || undefined,
      limit: 8,
      creds,
    })
    return { ok: true, numbers }
  } catch (err) {
    console.error("[twilio-provision] search failed:", err)
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Couldn't reach Twilio — try again.",
    }
  }
}

export type ProvisionTwilioNumberResult =
  | { ok: true; phoneNumber: string }
  | { ok: false; error: string }

/**
 * Buys a specific number, wires up the SmsUrl + StatusCallback to
 * point at Gradia's webhooks, and persists the result on the shop
 * row. The encoded SmsUrl is shared across all shops on Gradia's
 * master account — the inbound webhook handler routes by the `To`
 * number, so one URL is fine.
 */
export async function provisionTwilioNumber(input: {
  phoneNumber: string
}): Promise<ProvisionTwilioNumberResult> {
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }

  const creds = resolveTwilioCredentials(shop)
  if (!creds) {
    return {
      ok: false,
      error: "Twilio isn't configured on the server yet.",
    }
  }

  const origin = await resolveOrigin()
  const smsUrl = `${origin}/api/twilio/sms`
  const statusCallback = `${origin}/api/twilio/sms/status?shop=${encodeURIComponent(shop.id)}`

  try {
    const provisioned = await provisionPhoneNumber({
      phoneNumber: input.phoneNumber,
      smsUrl,
      statusCallback,
      friendlyName: shop.name ?? null,
      creds,
    })

    const supabase = await createClient()
    const { error } = await supabase
      .from("shops")
      .update({ twilio_phone_number: provisioned.phoneNumber })
      .eq("id", shop.id)

    if (error) {
      // Best-effort rollback — release the number we just bought so
      // we don't pay rent on a number that isn't linked to any shop.
      try {
        await releasePhoneNumber({ sid: provisioned.sid, creds })
      } catch (rollbackErr) {
        console.error(
          "[twilio-provision] rollback release failed:",
          rollbackErr
        )
      }
      return {
        ok: false,
        error:
          "Couldn't save the number to our shop — released it. Try again.",
      }
    }

    revalidatePath("/settings")
    return { ok: true, phoneNumber: provisioned.phoneNumber }
  } catch (err) {
    console.error("[twilio-provision] provision failed:", err)
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Couldn't buy the number — try again.",
    }
  }
}

export type ReleaseTwilioNumberResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Disconnect + release: clears the shop's number and tells Twilio to
 * drop the rental. Used by the "Release & disconnect" action on the
 * connected-state card. Safer than the existing disconnectSms (which
 * only clears the column) when the operator wants to stop the monthly
 * charge on Gradia's master account.
 */
export async function releaseTwilioNumber(): Promise<ReleaseTwilioNumberResult> {
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }
  if (!shop.twilio_phone_number) {
    return { ok: false, error: "No number to release." }
  }

  const creds = resolveTwilioCredentials(shop)
  if (!creds) {
    return {
      ok: false,
      error: "Twilio isn't configured on the server yet.",
    }
  }

  try {
    const sid = await findIncomingPhoneNumberSid({
      phoneNumber: shop.twilio_phone_number,
      creds,
    })
    if (sid) {
      await releasePhoneNumber({ sid, creds })
    }

    const supabase = await createClient()
    const { error } = await supabase
      .from("shops")
      .update({ twilio_phone_number: null })
      .eq("id", shop.id)
    if (error) {
      return { ok: false, error: error.message }
    }

    revalidatePath("/settings")
    return { ok: true }
  } catch (err) {
    console.error("[twilio-provision] release failed:", err)
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Couldn't release the number — try again.",
    }
  }
}
