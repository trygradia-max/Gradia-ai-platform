"use server"

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

import {
  findIncomingPhoneNumberSid,
  hasMasterTwilioCredentials,
  listIncomingPhoneNumbers,
  setNumberSmsWebhook,
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
import {
  claimNumberPurchase,
  purchaseNumber,
  releaseNumberPurchaseClaim,
} from "@/lib/telephony-provider"
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

  // BYO shops search their own account. Everyone else searches the
  // account-independent pool through the master account (as
  // telephony-provider searchNumbers does); the purchase itself happens on
  // the shop's subaccount. Credentials for SENDING stay scoped (I1).
  const byo = Boolean(shop.twilio_account_sid_enc)
  const creds = byo ? resolveTwilioCredentials(shop) : undefined
  if (byo ? !creds : !hasMasterTwilioCredentials()) {
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
 * BYO shops provision on their own account (provisionOwnAccountNumber),
 * single-flight like purchaseNumber, wiring SmsUrl + StatusCallback at
 * Gradia. (Their rental bills to their Twilio account, so no metering.)
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
  const result = await provisionOwnAccountNumber({
    supabase: createServiceClient(),
    shop,
    creds,
    phoneNumber: input.phoneNumber,
    origin,
  })
  if (result.ok) revalidatePath("/settings")
  return result
}

/**
 * BYO provisioning, single-flight like purchaseNumber (number-lifecycle
 * audit). Under the business's purchase claim it:
 *   - refuses if a texting number is already stored (no silent overwrite
 *     that strands the old number on the owner's account);
 *   - adopts the number if it is already on the owner's account (a save
 *     that failed, or a response lost in transit), instead of buying again;
 *   - writes only if no number is stored, and releases its own duplicate if
 *     another provision stored first;
 *   - never answers a failed save by releasing the number: the save may have
 *     committed, and a failed release would strand it. The retry adopts it.
 * The rental bills to the owner's Twilio account, so nothing is metered.
 */
async function provisionOwnAccountNumber(input: {
  supabase: ReturnType<typeof createServiceClient>
  shop: ShopRow
  creds: NonNullable<ReturnType<typeof resolveTwilioCredentials>>
  phoneNumber: string
  origin: string
}): Promise<ProvisionTwilioNumberResult> {
  const { supabase, shop, creds, phoneNumber, origin } = input
  const smsUrl = `${origin}/api/twilio/sms`
  const statusCallback = `${origin}/api/twilio/sms/status?shop=${encodeURIComponent(shop.id)}`
  const alreadyHasNumber = { ok: false as const, error: "This business already has a texting number. Disconnect or release it first." }

  const claimed = await claimNumberPurchase(supabase, shop.id)
  if (!claimed.ok) return { ok: false, error: claimed.error }
  try {
    const { data: current, error: readError } = await supabase
      .from("shops")
      .select("twilio_phone_number")
      .eq("id", shop.id)
      .single()
    if (readError || !current) return { ok: false, error: "Couldn't read the business number. Try again." }
    if ((current as { twilio_phone_number: string | null }).twilio_phone_number) return alreadyHasNumber

    let number: { sid: string; phoneNumber: string }
    let adopted = false
    const onAccount = async () =>
      (await listIncomingPhoneNumbers({ creds, phoneNumber })).find((n) => n.phoneNumber === phoneNumber) ?? null
    try {
      const existing = await onAccount()
      if (existing) {
        number = existing
        adopted = true
        // Our earlier provision set these; set them again so inbound routes here.
        await setNumberSmsWebhook({ sid: existing.sid, smsUrl, creds })
      } else {
        try {
          number = await provisionPhoneNumber({ phoneNumber, smsUrl, statusCallback, friendlyName: shop.name ?? null, creds })
        } catch (err) {
          const found = await onAccount().catch(() => null)
          if (!found) throw err
          number = found
          adopted = true
          console.warn("[twilio-provision] provisioning errored but the number is on the owner's account; adopting:", { shopId: shop.id })
        }
      }
    } catch (err) {
      console.error("[twilio-provision] provision failed:", err)
      return { ok: false, error: err instanceof Error ? err.message : "Couldn't buy the number — try again." }
    }

    // Service role: twilio_phone_number is server-written (I1). The number is
    // on the shop's own account; the shop is the owner's (requireShop).
    const { data: saved, error } = await supabase
      .from("shops")
      .update({ twilio_phone_number: number.phoneNumber })
      .eq("id", shop.id)
      .is("twilio_phone_number", null)
      .select("id")
    if (error) {
      console.error(`[twilio-provision] number ${number.sid} saved at Twilio but not here — the retry adopts it:`, error)
      return { ok: false, error: "Got the number but couldn't save it. Try again with the same number; it won't be bought twice." }
    }
    if (!(saved as { id: string }[] | null)?.length) {
      // Another provision stored a number first.
      if (!adopted) {
        await releasePhoneNumber({ sid: number.sid, creds }).catch((err) =>
          console.error(`[twilio-provision] couldn't release duplicate number ${number.sid} for shop ${shop.id} — reconcile:`, err)
        )
      }
      return alreadyHasNumber
    }
    return { ok: true, phoneNumber: number.phoneNumber }
  } finally {
    await releaseNumberPurchaseClaim(supabase, shop.id, claimed.claim)
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
    if (isGradiaNumber) {
      // The subaccount belongs to this business alone, so every number on it
      // is this business's: release them all, including a duplicate a
      // concurrent purchase failed to release, so none stays billed. A 404
      // (already released, e.g. a lost response earlier) counts as released.
      // Any failure leaves the row as it is, and the retry finishes the job.
      const sids = new Set(
        (await listIncomingPhoneNumbers({ creds })).map((n) => n.sid)
      )
      if (shop.gradia_number_sid) sids.add(shop.gradia_number_sid)
      for (const sid of sids) await releasePhoneNumber({ sid, creds })
    } else {
      const sid = await findIncomingPhoneNumberSid({
        phoneNumber: shop.twilio_phone_number,
        creds,
      })
      if (sid) {
        await releasePhoneNumber({ sid, creds })
      }
    }

    const supabase = createServiceClient()
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
