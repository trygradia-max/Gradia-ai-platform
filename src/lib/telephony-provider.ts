/**
 * Telephony provider seam — the vendor-neutral surface for everything
 * white-label telephony (TELEPHONY_VOICE_BUILDER_SPEC Phase 1).
 *
 * Locked principle: all vendor calls go through this seam; no Twilio types
 * leak past it. lib/twilio.ts is the Twilio implementation detail behind
 * this module — new feature code imports from HERE, not from twilio.ts.
 * (Legacy call sites — BYO SMS send, webhook verification — still import
 * twilio.ts directly; they migrate here as they're touched.)
 *
 * Invariants enforced in code, not convention:
 * - Subaccount is created on FIRST NUMBER PURCHASE, never at signup.
 * - Credit pre-check runs BEFORE any vendor spend (fail closed).
 * - Outbound SMS on a Gradia-provisioned number is blocked until the A2P
 *   campaign is approved (`a2p_status === 'approved'`).
 * - Every purchase writes a usage_events row with wholesale + retail cost
 *   and the vendor ref, so margin and reconciliation are always computable.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { encryptSecret, tryDecryptSecret } from "@/lib/crypto"
import { precheckCredits, recordUsage } from "@/lib/credits"
import { getPricing, priceUsage } from "@/lib/pricing"
import {
  createSubaccount,
  defaultStatusCallbackUrl,
  provisionPhoneNumber,
  releasePhoneNumber,
  searchAvailableNumbers,
  TwilioError,
} from "@/lib/twilio"
import {
  attachNumberToMessagingService,
  createBrand,
  createCampaign,
  createMessagingService,
  getBrandStatus,
  getCampaignStatus,
  registerA2pTrustProduct,
  registerBusinessProfile,
} from "@/lib/twilio-a2p"
import type {
  A2pBusinessDetails,
  A2pRegistrationRow,
  ShopRow,
} from "@/lib/types/database"

// ---------- Vendor-neutral types ----------

export type AvailableNumber = {
  /** E.164, ready to purchase. */
  e164: string
  /** Human-readable form, e.g. "(617) 555-0142". */
  display: string
  locality: string | null
  region: string | null
}

export type PurchaseResult =
  | {
      ok: true
      e164: string
      /** Owner-facing monthly retail price in cents. */
      monthlyRetailCents: number
    }
  | { ok: false; error: string }

export type SmsGate =
  | { allowed: true }
  | { allowed: false; reason: string }

type ShopTelephonyFields = Pick<
  ShopRow,
  | "id"
  | "name"
  | "twilio_subaccount_sid"
  | "twilio_subaccount_token_enc"
  | "gradia_number_e164"
  | "gradia_number_sid"
  | "a2p_status"
  | "plan"
  | "credit_period_start"
>

type SubaccountCreds = { accountSid: string; authToken: string }

// ---------- Subaccount lifecycle ----------

/**
 * Returns the shop's subaccount credentials, creating the subaccount on
 * first use. Only the purchase flow should trigger creation — searching
 * doesn't (no empty subaccounts when an owner abandons the wizard).
 */
export async function ensureSubaccount(
  supabase: SupabaseClient,
  shop: ShopTelephonyFields
): Promise<SubaccountCreds> {
  const existingToken = tryDecryptSecret(shop.twilio_subaccount_token_enc)
  if (shop.twilio_subaccount_sid && existingToken) {
    return { accountSid: shop.twilio_subaccount_sid, authToken: existingToken }
  }

  const sub = await createSubaccount({ friendlyName: shop.id })
  const { error } = await supabase
    .from("shops")
    .update({
      twilio_subaccount_sid: sub.sid,
      twilio_subaccount_token_enc: encryptSecret(sub.authToken),
    })
    .eq("id", shop.id)
  if (error) {
    // The subaccount exists at Twilio but we couldn't persist it — surface
    // loudly; retrying purchase would orphan another one.
    console.error("[telephony] subaccount persist failed:", error)
    throw new Error(
      "Created the phone account but couldn't save it — try again or contact support."
    )
  }
  return { accountSid: sub.sid, authToken: sub.authToken }
}

// ---------- Number search & purchase ----------

/**
 * Searches purchasable local numbers (voice + SMS capable). Runs under the
 * master account — the available pool is account-independent and searching
 * must not create a subaccount.
 */
export async function searchNumbers(input: {
  areaCode?: string
  limit?: number
}): Promise<AvailableNumber[]> {
  const results = await searchAvailableNumbers({
    areaCode: input.areaCode,
    limit: input.limit,
  })
  return results.map((n) => ({
    e164: n.phoneNumber,
    display: n.friendlyName,
    locality: n.locality,
    region: n.region,
  }))
}

/**
 * Buys a number for the shop, end to end: credit pre-check (fail closed,
 * BEFORE any vendor call) → ensure subaccount → provision under the
 * subaccount with webhooks pointed at Gradia → persist on the shop →
 * meter `number_monthly` at retail with the vendor ref.
 *
 * The number is voice-ready immediately; outbound SMS stays blocked until
 * A2P approval (`smsGateForShop`). One number per shop in v1.
 */
export async function purchaseNumber(input: {
  supabase: SupabaseClient
  shop: ShopTelephonyFields
  e164: string
  /** Public origin for webhook URLs (resolve from request/env at call site). */
  origin: string
}): Promise<PurchaseResult> {
  const { supabase, shop, e164, origin } = input

  if (shop.gradia_number_e164) {
    return { ok: false, error: "This shop already has a business number." }
  }

  const pricing = await getPricing(supabase)
  const priced = priceUsage(pricing, "number_monthly")

  const check = await precheckCredits(supabase, shop, priced.credits)
  if (!check.ok) return { ok: false, error: check.reason }

  let creds: SubaccountCreds
  try {
    creds = await ensureSubaccount(supabase, shop)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't set up the phone account.",
    }
  }

  try {
    const provisioned = await provisionPhoneNumber({
      phoneNumber: e164,
      smsUrl: `${origin}/api/twilio/sms`,
      statusCallback: defaultStatusCallbackUrl(shop.id),
      friendlyName: shop.name,
      creds,
    })

    const { error: persistError } = await supabase
      .from("shops")
      .update({
        gradia_number_e164: provisioned.phoneNumber,
        gradia_number_sid: provisioned.sid,
        // The active number for sends + inbound routing. Setting it equal to
        // gradia_number_e164 is also what flips resolveTwilioCredentials to
        // the subaccount and arms the A2P gate at the send boundary.
        twilio_phone_number: provisioned.phoneNumber,
        a2p_status: "unregistered",
      })
      .eq("id", shop.id)
    if (persistError) {
      console.error("[telephony] number persist failed:", persistError)
      // Roll the rental back rather than strand a paid number nobody can see.
      await releasePhoneNumber({ sid: provisioned.sid, creds }).catch((e) =>
        console.error("[telephony] rollback release failed:", e)
      )
      return { ok: false, error: "Couldn't save the number — nothing was charged. Try again." }
    }

    await recordUsage(supabase, shop.id, "number_monthly", {
      credits: priced.credits,
      wholesaleCost: priced.wholesale_cost,
      retailCost: priced.retail_cost,
      vendorRef: provisioned.sid,
      refId: provisioned.phoneNumber,
    })

    return {
      ok: true,
      e164: provisioned.phoneNumber,
      monthlyRetailCents: priced.retail_cost,
    }
  } catch (err) {
    const message =
      err instanceof TwilioError
        ? "That number was just taken — pick another."
        : "Couldn't purchase the number. Try again."
    console.error("[telephony] purchase failed:", err)
    return { ok: false, error: message }
  }
}

// ---------- A2P 10DLC registration pipeline ----------

export type A2pStartResult =
  | { ok: true }
  | { ok: false; error: string }

function subaccountCredsOrNull(
  shop: ShopTelephonyFields
): SubaccountCreds | null {
  const token = tryDecryptSecret(shop.twilio_subaccount_token_enc)
  return shop.twilio_subaccount_sid && token
    ? { accountSid: shop.twilio_subaccount_sid, authToken: token }
    : null
}

/**
 * Kicks off carrier registration for the shop's Gradia number: secondary
 * customer profile → A2P trust product → brand, all under the shop's
 * subaccount (skill: do not reorder). On success the registration row is
 * `brand_pending` and shops.a2p_status flips to 'pending'; syncA2pStatus
 * advances the rest as Twilio reviews. Re-running after a rejection
 * resubmits with the corrected details (a fresh profile chain — TrustHub
 * bundles are immutable once reviewed).
 *
 * Compliance failures (EIN/name mismatch, etc.) come back as actionable
 * errors and leave the row in `draft`/`rejected`, never half-registered.
 */
export async function startA2pRegistration(input: {
  supabase: SupabaseClient
  shop: ShopTelephonyFields
  business: A2pBusinessDetails
  /** Public origin for the status callback URL. */
  origin: string
}): Promise<A2pStartResult> {
  const { supabase, shop, business, origin } = input

  if (!shop.gradia_number_e164) {
    return { ok: false, error: "Buy a business number first — registration attaches to it." }
  }
  const creds = subaccountCredsOrNull(shop)
  if (!creds) {
    return { ok: false, error: "This number isn't on a Gradia phone account — contact support." }
  }
  const primaryProfileSid = process.env.TWILIO_PRIMARY_PROFILE_SID?.trim()
  if (!primaryProfileSid) {
    return { ok: false, error: "Carrier registration isn't configured on the server yet." }
  }

  // Persist the submitted details first so a mid-pipeline failure never
  // loses the owner's form input.
  const { error: upsertError } = await supabase.from("a2p_registrations").upsert(
    {
      shop_id: shop.id,
      status: "draft",
      business,
      failure_reason: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_id" }
  )
  if (upsertError) {
    console.error("[telephony] a2p upsert failed:", upsertError)
    return { ok: false, error: "Couldn't save your details — try again." }
  }

  const statusCallback = `${origin}/api/twilio/a2p/status?shop=${encodeURIComponent(shop.id)}`

  try {
    const { customerProfileSid } = await registerBusinessProfile(creds, business, {
      primaryProfileSid,
      statusCallback,
      friendlyName: business.legal_name,
    })
    const { trustProductSid } = await registerA2pTrustProduct(creds, {
      customerProfileSid,
      email: business.contact.email,
      friendlyName: `${business.legal_name} — A2P`,
      statusCallback,
    })
    const { brandSid } = await createBrand(creds, { customerProfileSid, trustProductSid })

    await supabase
      .from("a2p_registrations")
      .update({
        status: "brand_pending",
        customer_profile_sid: customerProfileSid,
        trust_product_sid: trustProductSid,
        brand_sid: brandSid,
        updated_at: new Date().toISOString(),
      })
      .eq("shop_id", shop.id)
    await supabase.from("shops").update({ a2p_status: "pending" }).eq("id", shop.id)
    return { ok: true }
  } catch (err) {
    const reason =
      err instanceof TwilioError && err.status === 400
        ? err.message
        : "Carrier registration hit a snag on our side — try again or contact support."
    console.error("[telephony] a2p registration failed:", err)
    await supabase
      .from("a2p_registrations")
      .update({ failure_reason: reason, updated_at: new Date().toISOString() })
      .eq("shop_id", shop.id)
    return { ok: false, error: reason }
  }
}

export type A2pSyncResult = {
  status: A2pRegistrationRow["status"]
  failureReason: string | null
}

/**
 * Advances the registration pipeline one stage if Twilio has moved:
 * brand approved → create messaging service (inbound stays on Gradia's SMS
 * handler) + campaign; campaign verified → attach the number and open the
 * SMS gate (the ONLY place a2p_status becomes 'approved'). Idempotent —
 * safe from the status webhook, a manual refresh, and cron alike.
 */
export async function syncA2pStatus(input: {
  supabase: SupabaseClient
  shop: ShopTelephonyFields
  origin: string
}): Promise<A2pSyncResult> {
  const { supabase, shop, origin } = input

  const { data } = await supabase
    .from("a2p_registrations")
    .select("*")
    .eq("shop_id", shop.id)
    .maybeSingle()
  const reg = (data as A2pRegistrationRow | null) ?? null
  if (!reg) return { status: "draft", failureReason: null }
  const creds = subaccountCredsOrNull(shop)
  if (!creds) return { status: reg.status, failureReason: reg.failure_reason }

  const reject = async (reason: string): Promise<A2pSyncResult> => {
    await supabase
      .from("a2p_registrations")
      .update({ status: "rejected", failure_reason: reason, updated_at: new Date().toISOString() })
      .eq("shop_id", shop.id)
    await supabase.from("shops").update({ a2p_status: "rejected" }).eq("id", shop.id)
    return { status: "rejected", failureReason: reason }
  }

  try {
    if (reg.status === "brand_pending" && reg.brand_sid) {
      const brand = await getBrandStatus(creds, reg.brand_sid)
      if (brand.status === "FAILED") {
        return reject(
          brand.failureReason ??
            "Carriers couldn't verify the business — double-check the legal name matches the EIN exactly."
        )
      }
      if (brand.status === "APPROVED") {
        const { messagingServiceSid } = await createMessagingService(creds, {
          friendlyName: `${shop.name} — Gradia messaging`,
          inboundSmsUrl: `${origin}/api/twilio/sms`,
        })
        const { campaignSid } = await createCampaign(creds, {
          messagingServiceSid,
          brandSid: reg.brand_sid,
          shopName: shop.name,
        })
        await supabase
          .from("a2p_registrations")
          .update({
            status: "campaign_pending",
            messaging_service_sid: messagingServiceSid,
            campaign_sid: campaignSid,
            updated_at: new Date().toISOString(),
          })
          .eq("shop_id", shop.id)
        return { status: "campaign_pending", failureReason: null }
      }
      return { status: "brand_pending", failureReason: null }
    }

    if (reg.status === "campaign_pending" && reg.messaging_service_sid && reg.campaign_sid) {
      const campaign = await getCampaignStatus(creds, reg.messaging_service_sid, reg.campaign_sid)
      if (campaign.status === "FAILED") {
        return reject(
          campaign.errors ??
            "Carriers rejected the campaign — contact support and we'll adjust the registration."
        )
      }
      if (campaign.status === "VERIFIED") {
        if (shop.gradia_number_sid) {
          await attachNumberToMessagingService(creds, {
            messagingServiceSid: reg.messaging_service_sid,
            phoneNumberSid: shop.gradia_number_sid,
          })
        }
        await supabase
          .from("a2p_registrations")
          .update({ status: "approved", failure_reason: null, updated_at: new Date().toISOString() })
          .eq("shop_id", shop.id)
        await supabase.from("shops").update({ a2p_status: "approved" }).eq("id", shop.id)
        return { status: "approved", failureReason: null }
      }
      return { status: "campaign_pending", failureReason: null }
    }
  } catch (err) {
    // Transient vendor error — keep the current stage; the next sync retries.
    console.error("[telephony] a2p sync failed:", err)
  }

  return { status: reg.status, failureReason: reg.failure_reason }
}

// ---------- A2P gate ----------

/**
 * Whether outbound SMS may leave on the shop's Gradia-provisioned number.
 * Enforced in code at the send boundary — never by convention. Shops on
 * BYO credentials are not gated here (their A2P standing is their own
 * account's).
 */
export function smsGateForShop(
  shop: Pick<ShopRow, "gradia_number_e164" | "a2p_status">,
  fromNumber: string
): SmsGate {
  const isGradiaNumber =
    Boolean(shop.gradia_number_e164) && fromNumber === shop.gradia_number_e164
  if (!isGradiaNumber) return { allowed: true }
  if (shop.a2p_status === "approved") return { allowed: true }
  return {
    allowed: false,
    reason:
      shop.a2p_status === "rejected"
        ? "Carrier registration was rejected — review your business details in Settings → Business Number."
        : "Your number is still being verified by carriers (1–3 days). Texting unlocks when it's approved.",
  }
}
