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
import { sameBusinessDetails } from "@/lib/a2p-state"
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
  createSoleProprietorBrand,
  getBrandStatus,
  getCampaignStatus,
  registerA2pTrustProduct,
  registerBusinessProfile,
  registerSoleProprietorProfile,
  resendSoleProprietorOtp,
} from "@/lib/twilio-a2p"
import type {
  A2pBusinessDetails,
  A2pRegistrationRow,
  A2pRegistrationStep,
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

/** A step failure: which step, the owner-facing reason, and whether retrying can fix it. */
class A2pStepError extends Error {
  constructor(readonly step: A2pRegistrationStep, readonly retryable: boolean, message: string) {
    super(message)
  }
}

/** Twilio 400s are refusals of the submitted details; anything else is temporary. */
function stepFailure(step: A2pRegistrationStep, err: unknown): A2pStepError {
  if (err instanceof A2pStepError) return err
  if (err instanceof TwilioError && err.status === 400) return new A2pStepError(step, false, err.message)
  return new A2pStepError(step, true, "Carrier registration hit a temporary problem on our side. Try again; finished steps are kept.")
}

async function a2pUpdate(supabase: SupabaseClient, shopId: string, step: A2pRegistrationStep, patch: Record<string, unknown>) {
  const { error } = await supabase
    .from("a2p_registrations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
  if (error) {
    console.error(`[telephony] a2p checkpoint failed at ${step}:`, error)
    throw new A2pStepError(step, true, "Couldn't save registration progress. Try again; finished steps are kept.")
  }
}

/**
 * Submits (or resumes, or resubmits) carrier registration for the shop's
 * Gradia number: customer profile → A2P trust product → brand, under the
 * shop's subaccount (skill: do not reorder). See CHANNEL_PROVIDERS.md.
 *
 * Resumable: each step's SID is saved the moment it exists. Submitting the
 * same details again after a temporary failure continues after the last
 * completed step instead of creating a second profile or brand.
 *   - With carriers (brand/campaign pending) or approved: refused; nothing
 *     is created.
 *   - Rejected brand, or changed details: a fresh chain (TrustHub bundles
 *     are immutable once reviewed).
 *   - Rejected campaign with the same details: the approved brand is kept;
 *     the next status check creates a new campaign.
 * A failure records the step, whether retrying can fix it, and the reason,
 * and leaves the row in `draft`, never half-registered.
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
  // Only the EIN path links to Gradia's primary profile; sole-prop uses
  // the starter-profile policy and doesn't need it.
  const primaryProfileSid = process.env.TWILIO_PRIMARY_PROFILE_SID?.trim() ?? ""
  if (business.has_ein !== false && !primaryProfileSid) {
    return { ok: false, error: "Carrier registration isn't configured on the server yet." }
  }

  const { data: existingData, error: readError } = await supabase
    .from("a2p_registrations")
    .select("*")
    .eq("shop_id", shop.id)
    .maybeSingle()
  if (readError) return { ok: false, error: "Couldn't read your registration — try again." }
  const existing = (existingData as A2pRegistrationRow | null) ?? null
  if (existing && ["brand_pending", "campaign_pending", "approved"].includes(existing.status)) {
    return {
      ok: false,
      error: existing.status === "approved"
        ? "Texting is already approved for this number."
        : "Your registration is already with the carriers. Check status instead of submitting again.",
    }
  }
  const sameDetails = existing !== null && sameBusinessDetails(existing.business, business)
  const now = new Date().toISOString()
  const attempt = { attempts: (existing?.attempts ?? 0) + 1, last_attempt_at: now, failure_reason: null, failed_step: null, retryable: null, updated_at: now }

  // Carriers rejected only the campaign: keep the approved brand.
  if (existing?.status === "rejected" && existing.failed_step === "campaign" && existing.brand_sid && sameDetails) {
    const { error } = await supabase.from("a2p_registrations")
      .update({ ...attempt, status: "brand_pending", campaign_sid: null })
      .eq("shop_id", shop.id).eq("status", "rejected")
    if (error) return { ok: false, error: "Couldn't save your resubmission — try again." }
    await supabase.from("shops").update({ a2p_status: "pending" }).eq("id", shop.id)
    return { ok: true }
  }

  // Resume only a draft with the same details; anything else starts fresh.
  const resume = existing?.status === "draft" && sameDetails
  const sids = resume
    ? { customer_profile_sid: existing.customer_profile_sid, trust_product_sid: existing.trust_product_sid, brand_sid: existing.brand_sid }
    : { customer_profile_sid: null, trust_product_sid: null, brand_sid: null }
  // Persist the submitted details first so a mid-pipeline failure never
  // loses the owner's form input.
  const { error: upsertError } = await supabase.from("a2p_registrations").upsert(
    {
      shop_id: shop.id,
      status: "draft",
      business,
      ...sids,
      ...(resume ? {} : { messaging_service_sid: null, campaign_sid: null }),
      ...attempt,
    },
    { onConflict: "shop_id" }
  )
  if (upsertError) {
    console.error("[telephony] a2p upsert failed:", upsertError)
    return { ok: false, error: "Couldn't save your details — try again." }
  }

  const statusCallback = `${origin}/api/twilio/a2p/status?shop=${encodeURIComponent(shop.id)}`
  let step: A2pRegistrationStep = "profile"
  try {
    // The fork (twilio-isv-telephony skill): EIN → Low-Volume Standard;
    // no EIN → SOLE_PROPRIETOR with mobile OTP verification.
    let customerProfileSid = sids.customer_profile_sid
    let trustProductSid = sids.trust_product_sid
    let brandSid = sids.brand_sid
    if (business.has_ein === false) {
      if (!customerProfileSid || !trustProductSid) {
        const profile = await registerSoleProprietorProfile(creds, business, { statusCallback, friendlyName: business.legal_name })
        customerProfileSid = profile.customerProfileSid
        trustProductSid = profile.trustProductSid
        await a2pUpdate(supabase, shop.id, step, { customer_profile_sid: customerProfileSid, trust_product_sid: trustProductSid })
      }
      step = "brand"
      if (!brandSid) {
        brandSid = (await createSoleProprietorBrand(creds, { customerProfileSid, trustProductSid })).brandSid
        await a2pUpdate(supabase, shop.id, step, { brand_sid: brandSid })
      }
    } else {
      if (!customerProfileSid) {
        customerProfileSid = (await registerBusinessProfile(creds, business, { primaryProfileSid, statusCallback, friendlyName: business.legal_name })).customerProfileSid
        await a2pUpdate(supabase, shop.id, step, { customer_profile_sid: customerProfileSid })
      }
      step = "trust_product"
      if (!trustProductSid) {
        trustProductSid = (await registerA2pTrustProduct(creds, {
          customerProfileSid,
          email: business.contact.email,
          friendlyName: `${business.legal_name} — A2P`,
          statusCallback,
        })).trustProductSid
        await a2pUpdate(supabase, shop.id, step, { trust_product_sid: trustProductSid })
      }
      step = "brand"
      if (!brandSid) {
        brandSid = (await createBrand(creds, { customerProfileSid, trustProductSid })).brandSid
        await a2pUpdate(supabase, shop.id, step, { brand_sid: brandSid })
      }
    }

    await a2pUpdate(supabase, shop.id, step, { status: "brand_pending" })
    await supabase.from("shops").update({ a2p_status: "pending" }).eq("id", shop.id)
    return { ok: true }
  } catch (err) {
    const failure = stepFailure(step, err)
    console.error(`[telephony] a2p registration failed at ${failure.step}:`, err)
    await supabase
      .from("a2p_registrations")
      .update({ failure_reason: failure.message, failed_step: failure.step, retryable: failure.retryable, updated_at: new Date().toISOString() })
      .eq("shop_id", shop.id)
    return { ok: false, error: failure.message }
  }
}

export type A2pSyncResult = {
  status: A2pRegistrationRow["status"]
  failureReason: string | null
}

/**
 * Advances the registration pipeline one stage if Twilio has moved:
 * brand approved → messaging service (created once, inbound stays on Gradia's
 * SMS handler) → campaign; campaign verified → attach the number and open
 * the SMS gate (the ONLY place a2p_status becomes 'approved'). Idempotent —
 * safe from the status webhook, a manual refresh, and cron alike. A temporary
 * failure in a later step is recorded and retried on the next check; a stage
 * is only reported as advanced once it is saved.
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

  const reject = async (step: A2pRegistrationStep, reason: string): Promise<A2pSyncResult> => {
    await a2pUpdate(supabase, shop.id, step, { status: "rejected", failure_reason: reason, failed_step: step, retryable: false })
    await supabase.from("shops").update({ a2p_status: "rejected" }).eq("id", shop.id)
    return { status: "rejected", failureReason: reason }
  }

  let step: A2pRegistrationStep = reg.status === "campaign_pending" ? "campaign" : "brand"
  try {
    if (reg.status === "brand_pending" && reg.brand_sid) {
      const brand = await getBrandStatus(creds, reg.brand_sid)
      if (brand.status === "FAILED") {
        return reject("brand",
          brand.failureReason ??
            "Carriers couldn't verify the business — double-check the legal name matches the EIN exactly."
        )
      }
      if (brand.status === "APPROVED") {
        step = "messaging_service"
        let messagingServiceSid = reg.messaging_service_sid
        if (!messagingServiceSid) {
          messagingServiceSid = (await createMessagingService(creds, {
            friendlyName: `${shop.name} — Gradia messaging`,
            inboundSmsUrl: `${origin}/api/twilio/sms`,
          })).messagingServiceSid
          await a2pUpdate(supabase, shop.id, step, { messaging_service_sid: messagingServiceSid })
        }
        step = "campaign"
        const { campaignSid } = await createCampaign(creds, {
          messagingServiceSid,
          brandSid: reg.brand_sid,
          shopName: shop.name,
          useCase:
            reg.business?.has_ein === false ? "SOLE_PROPRIETOR" : "LOW_VOLUME",
        })
        await a2pUpdate(supabase, shop.id, step, { status: "campaign_pending", campaign_sid: campaignSid, failed_step: null, retryable: null, failure_reason: null })
        return { status: "campaign_pending", failureReason: null }
      }
      return { status: "brand_pending", failureReason: reg.failure_reason }
    }

    if (reg.status === "campaign_pending" && reg.messaging_service_sid && reg.campaign_sid) {
      const campaign = await getCampaignStatus(creds, reg.messaging_service_sid, reg.campaign_sid)
      if (campaign.status === "FAILED") {
        return reject("campaign",
          campaign.errors ??
            "Carriers rejected the campaign — contact support and we'll adjust the registration."
        )
      }
      if (campaign.status === "VERIFIED") {
        step = "attach_number"
        if (shop.gradia_number_sid) {
          try {
            await attachNumberToMessagingService(creds, {
              messagingServiceSid: reg.messaging_service_sid,
              phoneNumberSid: shop.gradia_number_sid,
            })
          } catch (err) {
            // A retry after an attach whose result was lost: already attached is done.
            if (!(err instanceof TwilioError && /already/i.test(err.message))) throw err
          }
        }
        await a2pUpdate(supabase, shop.id, step, { status: "approved", failure_reason: null, failed_step: null, retryable: null })
        await supabase.from("shops").update({ a2p_status: "approved" }).eq("id", shop.id)
        return { status: "approved", failureReason: null }
      }
      return { status: "campaign_pending", failureReason: reg.failure_reason }
    }
  } catch (err) {
    // Temporary: keep the current stage, record the step, retry on the next check.
    const failure = stepFailure(step, err)
    console.error(`[telephony] a2p sync failed at ${failure.step}:`, err)
    const reason = failure.retryable
      ? "A temporary problem stopped the next registration step. It will be retried on the next status check."
      : failure.message
    await supabase
      .from("a2p_registrations")
      .update({ failed_step: failure.step, retryable: true, failure_reason: reason, updated_at: new Date().toISOString() })
      .eq("shop_id", shop.id)
    return { status: reg.status, failureReason: reason }
  }

  return { status: reg.status, failureReason: reg.failure_reason }
}

export type ResendOtpResult = { ok: true } | { ok: false; error: string }

/**
 * Re-sends the sole-prop verification text (24h answer window; a mobile
 * number has 3 lifetime uses across ALL carrier registrations, so don't
 * spam this).
 */
export async function resendA2pVerificationText(input: {
  supabase: SupabaseClient
  shop: ShopTelephonyFields
}): Promise<ResendOtpResult> {
  const { supabase, shop } = input
  const creds = subaccountCredsOrNull(shop)
  if (!creds) return { ok: false, error: "No phone account on file." }

  const { data } = await supabase
    .from("a2p_registrations")
    .select("brand_sid, status, business")
    .eq("shop_id", shop.id)
    .maybeSingle()
  const reg = (data as Pick<
    A2pRegistrationRow,
    "brand_sid" | "status" | "business"
  > | null) ?? null
  if (!reg?.brand_sid || reg.business?.has_ein !== false) {
    return { ok: false, error: "No verification text pending for this registration." }
  }
  try {
    await resendSoleProprietorOtp(creds, reg.brand_sid)
    return { ok: true }
  } catch (err) {
    console.error("[telephony] OTP resend failed:", err)
    return { ok: false, error: "Couldn't re-send the text — try again in a bit." }
  }
}

// ---------- A2P gate ----------

/**
 * Whether outbound SMS may leave from the shop's number. Enforced in code at
 * the send boundary — never by convention. A Gradia number needs A2P
 * approval. Any other number needs the owner's attestation, which only
 * `attest_byo_sms_registration` writes and a number change clears
 * (docs/architecture/BYO_SMS_ATTESTATION.md).
 */
export function smsGateForShop(
  shop: Pick<ShopRow, "gradia_number_e164" | "a2p_status" | "byo_sms_verified">,
  fromNumber: string
): SmsGate {
  const isGradiaNumber =
    Boolean(shop.gradia_number_e164) && fromNumber === shop.gradia_number_e164
  if (!isGradiaNumber) {
    // BYO number — Gradia can't see its carrier (A2P 10DLC) registration, so
    // we can't let it text unconditionally. The owner attests it's registered
    // (Settings → Business Number) before we'll send through it.
    if (shop.byo_sms_verified) return { allowed: true }
    return {
      allowed: false,
      reason:
        "Confirm your own number is registered for A2P 10DLC in Settings → Business Number before texting through it.",
    }
  }
  if (shop.a2p_status === "approved") return { allowed: true }
  return {
    allowed: false,
    reason:
      shop.a2p_status === "rejected"
        ? "Carrier registration was rejected — review your business details in Settings → Business Number."
        : "Your number is still being verified by carriers (1–3 days). Texting unlocks when it's approved.",
  }
}
