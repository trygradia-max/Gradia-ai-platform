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
import { getPricing } from "@/lib/pricing"
import { requireShop } from "@/lib/shop"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { purchaseNumber } from "@/lib/telephony-provider"
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
  | {
      ok: true
      numbers: TwilioAvailableNumber[]
      /** Gradia's retail monthly price in cents (from pricing_config).
       * Null for BYO shops — their rental bills to their own account. */
      monthlyRetailCents: number | null
    }
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
      error: "We're finishing texting setup on our side — check back soon.",
    }
  }

  try {
    const numbers = await searchAvailableNumbers({
      country: input.country?.trim() || "US",
      areaCode: input.areaCode?.trim() || undefined,
      limit: 8,
      creds,
    })
    const byo = Boolean(shop.twilio_account_sid_enc)
    const monthlyRetailCents = byo
      ? null
      : (await getPricing(createServiceClient())).number_monthly.retail_cents
    return { ok: true, numbers, monthlyRetailCents }
  } catch (err) {
    console.error("[twilio-provision] search failed:", err)
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Couldn't load numbers — try again.",
    }
  }
}

export type ProvisionTwilioNumberResult =
  | { ok: true; phoneNumber: string }
  | { ok: false; error: string }

/**
 * Buys a specific number for the shop.
 *
 * White-label shops (no BYO credentials) go through the telephony seam:
 * credit pre-check → per-shop subaccount → provision under it → metered
 * `number_monthly` at retail → A2P gate armed. Uses the service client —
 * the owner is already authorized via requireShop, and pricing_config /
 * the purchase write-path are server-only.
 *
 * BYO shops keep the legacy path: provision on their own account, wire
 * the SmsUrl + StatusCallback at Gradia, persist the number. (Their
 * rental bills to their Twilio account, so no Gradia metering.)
 */
export async function provisionTwilioNumber(input: {
  phoneNumber: string
}): Promise<ProvisionTwilioNumberResult> {
  const shop = await loadShop()
  if (!shop) return { ok: false, error: "Finish onboarding first." }

  const byo = Boolean(shop.twilio_account_sid_enc)
  if (!byo) {
    const origin = await resolveOrigin()
    const result = await purchaseNumber({
      supabase: createServiceClient(),
      shop,
      e164: input.phoneNumber,
      origin,
    })
    if (!result.ok) return { ok: false, error: result.error }
    revalidatePath("/settings")
    return { ok: true, phoneNumber: result.e164 }
  }

  const creds = resolveTwilioCredentials(shop)
  if (!creds) {
    return {
      ok: false,
      error: "We're finishing texting setup on our side — check back soon.",
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
      error: "We're finishing texting setup on our side — check back soon.",
    }
  }

  // White-label numbers: resolveTwilioCredentials already returned the
  // subaccount creds (the number only exists there), and the sid is stored.
  const isGradiaNumber =
    Boolean(shop.gradia_number_e164) &&
    shop.twilio_phone_number === shop.gradia_number_e164

  try {
    const sid =
      (isGradiaNumber ? shop.gradia_number_sid : null) ??
      (await findIncomingPhoneNumberSid({
        phoneNumber: shop.twilio_phone_number,
        creds,
      }))
    if (sid) {
      await releasePhoneNumber({ sid, creds })
    }

    const supabase = await createClient()
    const { error } = await supabase
      .from("shops")
      .update({
        twilio_phone_number: null,
        ...(isGradiaNumber
          ? {
              gradia_number_e164: null,
              gradia_number_sid: null,
              a2p_status: "unregistered" as const,
            }
          : {}),
      })
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
