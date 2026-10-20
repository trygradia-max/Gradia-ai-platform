/**
 * Saving a shop's texting number (shops.twilio_phone_number), server-side
 * only (review finding I1; migration 20261019130000 refuses the write from
 * a signed-in session). The caller has already authorized the owner and
 * passes a service-role client scoped by shop id.
 *
 * A number is accepted only when the shop provably holds it:
 *   - it is the shop's Gradia-provisioned number, or
 *   - it is the shop's allowlisted pilot number (TWILIO_PILOT_SHOP_NUMBERS), or
 *   - it is listed on the shop's OWN Twilio account (BYO credentials), asked
 *     of Twilio with those credentials only, never Gradia's master account.
 * Anything else fails closed. Clearing the number is always allowed.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { tryDecryptSecret } from "@/lib/crypto"
import { listIncomingPhoneNumbers, pilotEnvNumberFor } from "@/lib/twilio"
import type { ShopRow } from "@/lib/types/database"

export type SaveTextingNumberResult =
  | { ok: true; shop: ShopRow; via: "cleared" | "gradia" | "pilot" | "own_account" }
  | { ok: false; error: string; reason: "invalid" | "not_own_account" | "not_on_account" | "lookup_failed" | "taken" | "save_failed" }

const E164 = /^\+\d{8,15}$/

export async function saveShopTextingNumber(input: {
  db: SupabaseClient
  shopId: string
  value: string | null
}): Promise<SaveTextingNumberResult> {
  const { db, shopId } = input
  const value = input.value?.trim() || null
  if (value !== null && !E164.test(value)) {
    return { ok: false, reason: "invalid", error: "Use E.164 format (e.g. +15551234567)." }
  }

  const { data: row, error: readError } = await db
    .from("shops")
    .select("id, gradia_number_e164, twilio_account_sid_enc, twilio_auth_token_enc")
    .eq("id", shopId)
    .single()
  if (readError || !row) return { ok: false, reason: "save_failed", error: "Could not save." }
  const shop = row as Pick<ShopRow, "id" | "gradia_number_e164" | "twilio_account_sid_enc" | "twilio_auth_token_enc">

  let via: "cleared" | "gradia" | "pilot" | "own_account"
  if (value === null) via = "cleared"
  else if (shop.gradia_number_e164 && value === shop.gradia_number_e164) via = "gradia"
  else if (pilotEnvNumberFor(shopId) === value) via = "pilot"
  else {
    const accountSid = tryDecryptSecret(shop.twilio_account_sid_enc)
    const authToken = tryDecryptSecret(shop.twilio_auth_token_enc)
    if (!accountSid || !authToken) {
      return {
        ok: false,
        reason: "not_own_account",
        error: "Connect your own Twilio account first, then add a number from it — or buy a number through Gradia.",
      }
    }
    let onAccount: boolean
    try {
      const numbers = await listIncomingPhoneNumbers({ creds: { accountSid, authToken }, phoneNumber: value })
      onAccount = numbers.some((n) => n.phoneNumber === value)
    } catch (err) {
      console.error("[texting number] ownership lookup failed:", { shopId, error: err instanceof Error ? err.message : err })
      return { ok: false, reason: "lookup_failed", error: "Couldn't check that number with Twilio. Try again." }
    }
    if (!onAccount) {
      return {
        ok: false,
        reason: "not_on_account",
        error: "That number isn't on your connected Twilio account.",
      }
    }
    via = "own_account"
  }

  const { data, error } = await db
    .from("shops")
    .update({ twilio_phone_number: value })
    .eq("id", shopId)
    .select("*")
    .single()
  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, reason: "taken", error: "That number is already connected to another shop." }
    }
    return { ok: false, reason: "save_failed", error: "Could not save." }
  }
  return { ok: true, shop: data as ShopRow, via }
}
