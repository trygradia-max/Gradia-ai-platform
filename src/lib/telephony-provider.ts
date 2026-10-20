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
import { a2pEvidenceFresh } from "@/lib/a2p-evidence"
import { sameBusinessDetails } from "@/lib/a2p-state"
import { precheckCredits, recordUsage } from "@/lib/credits"
import { getPricing, priceUsage } from "@/lib/pricing"
import {
  closeSubaccount,
  createSubaccount,
  fetchSubaccount,
  listIncomingPhoneNumbers,
  listSubaccountsByFriendlyName,
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
  listCampaigns,
  registerA2pTrustProduct,
  registerBusinessProfile,
  registerSoleProprietorProfile,
  resendSoleProprietorOtp,
  updateCampaign,
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
 *
 * One subaccount per shop, and one shop per subaccount:
 *   - A stored SID is never replaced. If its token no longer decrypts, the
 *     token is recovered from Twilio for that same SID (it must be named for
 *     this shop); a new subaccount would strand the shop's number.
 *   - With no stored SID, an active subaccount already named for this shop
 *     (FriendlyName = shop id, e.g. one whose save failed earlier) is adopted.
 *     More than one is refused for reconciliation; nothing new is created.
 *   - The SID is saved only if none is stored yet. A concurrent purchase that
 *     stored first wins: the duplicate this call just created is closed (it
 *     has no numbers) and the winner's credentials are returned.
 *   - The database refuses one SID on two shops (unique index, migration 96).
 */
export async function ensureSubaccount(
  supabase: SupabaseClient,
  shop: ShopTelephonyFields
): Promise<SubaccountCreds> {
  const stored = await readStoredSubaccount(supabase, shop.id)
  if (stored.sid) return recoverStoredSubaccount(supabase, shop.id, stored)

  const named = await listSubaccountsByFriendlyName(shop.id)
  if (named.length > 1) {
    console.error(`[telephony] shop ${shop.id} has ${named.length} active subaccounts at Twilio — reconcile before purchasing`)
    throw new Error("This business has more than one phone account at our provider. Contact support before buying a number.")
  }
  const adopted = named[0] ?? null
  const sub = adopted ?? await createSubaccount({ friendlyName: shop.id })

  const { data: saved, error } = await supabase
    .from("shops")
    .update({
      twilio_subaccount_sid: sub.sid,
      twilio_subaccount_token_enc: encryptSecret(sub.authToken),
    })
    .eq("id", shop.id)
    .is("twilio_subaccount_sid", null)
    .select("id")
  if (error) {
    // Still recoverable: the next attempt adopts this subaccount by name.
    console.error("[telephony] subaccount persist failed:", error)
    throw new Error("Set up the phone account but couldn't save it. Try again; nothing extra will be created.")
  }
  if ((saved as { id: string }[] | null)?.length) {
    if (adopted) console.warn(`[telephony] adopted existing subaccount ${sub.sid} for shop ${shop.id}`)
    return { accountSid: sub.sid, authToken: sub.authToken }
  }

  // Another purchase stored a subaccount first. Keep the winner.
  const winner = await readStoredSubaccount(supabase, shop.id)
  if (!winner.sid) throw new Error("Couldn't confirm the phone account. Try again.")
  if (winner.sid !== sub.sid && !adopted) {
    await closeSubaccount(sub.sid).catch((err) =>
      console.error(`[telephony] couldn't close duplicate subaccount ${sub.sid} for shop ${shop.id} — reconcile:`, err)
    )
  }
  return recoverStoredSubaccount(supabase, shop.id, winner)
}

async function readStoredSubaccount(
  supabase: SupabaseClient,
  shopId: string
): Promise<{ sid: string | null; tokenEnc: string | null }> {
  const { data, error } = await supabase
    .from("shops")
    .select("twilio_subaccount_sid, twilio_subaccount_token_enc")
    .eq("id", shopId)
    .single()
  if (error) throw new Error("Couldn't read the phone account. Try again.")
  const row = data as { twilio_subaccount_sid: string | null; twilio_subaccount_token_enc: string | null }
  return { sid: row.twilio_subaccount_sid, tokenEnc: row.twilio_subaccount_token_enc }
}

/** Credentials for the stored SID, recovering its token from Twilio if needed. */
async function recoverStoredSubaccount(
  supabase: SupabaseClient,
  shopId: string,
  stored: { sid: string | null; tokenEnc: string | null }
): Promise<SubaccountCreds> {
  const sid = stored.sid as string
  const token = tryDecryptSecret(stored.tokenEnc)
  if (token) return { accountSid: sid, authToken: token }

  const account = await fetchSubaccount(sid)
  if (!account || account.status !== "active" || account.friendlyName !== shopId) {
    console.error(`[telephony] stored subaccount ${sid} for shop ${shopId} is missing, inactive or named for another shop — reconcile`)
    throw new Error("This business's phone account needs attention. Contact support; no new account was created.")
  }
  const { error } = await supabase
    .from("shops")
    .update({ twilio_subaccount_token_enc: encryptSecret(account.authToken) })
    .eq("id", shopId)
    .eq("twilio_subaccount_sid", sid)
  if (error) console.error(`[telephony] recovered subaccount token for shop ${shopId} but couldn't save it:`, error)
  return { accountSid: sid, authToken: account.authToken }
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
 * BEFORE any vendor call) → ensure subaccount → adopt or provision under
 * the subaccount with webhooks pointed at Gradia → persist on the shop →
 * meter `number_monthly` at retail with the vendor ref.
 *
 * Single-flight (review finding R8):
 *   - The stored number is re-read from the database, not the caller's
 *     snapshot. A shop that already has one gets it back; nothing is bought.
 *   - Before buying, the subaccount's numbers are listed. The subaccount
 *     belongs to this shop alone, so a number already on it is one this
 *     shop bought whose save failed or whose response was lost (or a
 *     concurrent purchase in flight): it is ADOPTED, never bought again.
 *     More than one is refused for reconciliation.
 *   - The number is written only if none is stored
 *     (`gradia_number_e164 IS NULL`). Only the call whose write lands
 *     meters `number_monthly`, so a number is metered once. A loser that
 *     provisioned its own duplicate releases it and returns the winner.
 *   - If provisioning errors, the subaccount is listed again and a number
 *     found there is adopted (a lost response, or a concurrent purchase of
 *     the same number).
 *   - A failed save keeps the provisioned number on the subaccount (it is
 *     not metered) so the retry adopts it. Releasing it instead could
 *     release a number whose save actually committed.
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
  const owned = (number: string): PurchaseResult => ({
    ok: true,
    e164: number,
    monthlyRetailCents: priced.retail_cost,
  })

  const before = await readStoredNumber(supabase, shop.id)
  if (!before.ok) return { ok: false, error: before.error }
  if (before.e164) return owned(before.e164)

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

  let onAccount: { sid: string; phoneNumber: string }[]
  try {
    onAccount = await listIncomingPhoneNumbers({ creds })
  } catch (err) {
    // Without the list we can't rule out a number bought earlier: don't buy.
    console.error("[telephony] couldn't list subaccount numbers before purchase:", err)
    return { ok: false, error: "Couldn't check the phone account. Try again; nothing was bought." }
  }
  if (onAccount.length > 1) {
    console.error(`[telephony] subaccount ${creds.accountSid} for shop ${shop.id} holds ${onAccount.length} numbers — reconcile before purchasing`)
    return { ok: false, error: "This business already has more than one number at our provider. Contact support; nothing new was bought." }
  }

  let number: { sid: string; phoneNumber: string }
  let adopted = false
  if (onAccount[0]) {
    number = onAccount[0]
    adopted = true
    console.warn(`[telephony] adopting number ${number.sid} already on subaccount ${creds.accountSid} for shop ${shop.id}`)
  } else {
    try {
      number = await provisionPhoneNumber({
        phoneNumber: e164,
        smsUrl: `${origin}/api/twilio/sms`,
        statusCallback: defaultStatusCallbackUrl(shop.id),
        friendlyName: shop.name,
        creds,
      })
    } catch (err) {
      // The number may exist anyway: a lost response, or a concurrent
      // purchase of this same number on this subaccount. Look again before
      // reporting failure; adopt it if it's there.
      const again = await listIncomingPhoneNumbers({ creds }).catch(() => null)
      if (again?.length === 1) {
        number = again[0]
        adopted = true
        console.warn(`[telephony] provisioning errored but number ${number.sid} is on subaccount ${creds.accountSid} for shop ${shop.id}; adopting:`, err)
      } else {
        const message =
          err instanceof TwilioError && err.status >= 400 && err.status < 500
            ? "That number was just taken — pick another."
            : "Couldn't purchase the number. Try again."
        console.error("[telephony] purchase failed:", err)
        return { ok: false, error: message }
      }
    }
  }

  const { data: saved, error: persistError } = await supabase
    .from("shops")
    .update({
      gradia_number_e164: number.phoneNumber,
      gradia_number_sid: number.sid,
      // The active number for sends + inbound routing. Setting it equal to
      // gradia_number_e164 is also what flips resolveTwilioCredentials to
      // the subaccount and arms the A2P gate at the send boundary.
      twilio_phone_number: number.phoneNumber,
      a2p_status: "unregistered",
    })
    .eq("id", shop.id)
    .is("gradia_number_e164", null)
    .select("id")
  if (persistError) {
    // Kept on the subaccount, unmetered: the next attempt adopts it.
    console.error(`[telephony] number ${number.sid} persist failed for shop ${shop.id} — the retry adopts it:`, persistError)
    return { ok: false, error: "Got the number but couldn't save it. Try again; you won't be charged twice." }
  }

  if (!(saved as { id: string }[] | null)?.length) {
    // Another purchase stored a number first. Keep the winner.
    const winner = await readStoredNumber(supabase, shop.id)
    if (!winner.ok || !winner.e164) {
      return { ok: false, error: "Couldn't confirm the number. Try again." }
    }
    if (winner.sid !== number.sid) {
      await releasePhoneNumber({ sid: number.sid, creds }).catch((err) =>
        console.error(`[telephony] couldn't release duplicate number ${number.sid} for shop ${shop.id} — reconcile:`, err)
      )
    }
    return owned(winner.e164)
  }

  await recordUsage(supabase, shop.id, "number_monthly", {
    credits: priced.credits,
    wholesaleCost: priced.wholesale_cost,
    retailCost: priced.retail_cost,
    vendorRef: number.sid,
    refId: number.phoneNumber,
  })
  if (adopted) console.warn(`[telephony] adopted number ${number.sid} saved and metered for shop ${shop.id}`)

  return owned(number.phoneNumber)
}

async function readStoredNumber(
  supabase: SupabaseClient,
  shopId: string
): Promise<{ ok: true; e164: string | null; sid: string | null } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("shops")
    .select("gradia_number_e164, gradia_number_sid")
    .eq("id", shopId)
    .single()
  if (error || !data) return { ok: false, error: "Couldn't read the business number. Try again." }
  const row = data as { gradia_number_e164: string | null; gradia_number_sid: string | null }
  return { ok: true, e164: row.gradia_number_e164, sid: row.gradia_number_sid }
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

/**
 * Claim lease. Longer than any server function can run (Vercel caps a
 * function far below this), so a live holder always finishes or dies before
 * the lease lapses; a crashed holder only delays the next attempt.
 */
const A2P_CLAIM_SECONDS = 15 * 60

/** Statuses a status check may advance or re-check (R4: approved keeps being watched). */
const A2P_SYNC_STATUSES = ["brand_pending", "campaign_pending", "approved", "suspended"] as const

/**
 * Takes the registration's single-flight claim with a compare-and-swap
 * before any provider call (R1, R2). Returns the token, or null when the row
 * isn't in one of `statuses` or someone else holds a live claim.
 */
async function claimA2p(supabase: SupabaseClient, shopId: string, statuses: readonly string[]): Promise<string | null> {
  const { data, error } = await supabase.rpc("a2p_claim_registration", {
    p_shop_id: shopId,
    p_statuses: statuses,
    p_lease_seconds: A2P_CLAIM_SECONDS,
  })
  if (error) {
    console.error("[telephony] a2p claim failed:", error)
    return null
  }
  return typeof data === "string" ? data : null
}

/** A checkpoint, written only while `token` still holds the claim. */
async function a2pUpdate(supabase: SupabaseClient, shopId: string, token: string, step: A2pRegistrationStep, patch: Record<string, unknown>) {
  const { data, error } = await supabase
    .from("a2p_registrations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("claim_token", token)
    .select("shop_id")
  if (error || !data?.length) {
    console.error(`[telephony] a2p checkpoint failed at ${step}:`, error ?? "claim lost")
    throw new A2pStepError(step, true, "Couldn't save registration progress. Try again; finished steps are kept.")
  }
}

type A2pFinish = {
  status?: A2pRegistrationRow["status"]
  shopStatus?: ShopRow["a2p_status"]
  patch?: Partial<Pick<A2pRegistrationRow, "failure_reason" | "failed_step" | "retryable" | "campaign_sid">>
  /**
   * The provider read this check made: "checked" (answered, not VERIFIED),
   * "verified" (the campaign read VERIFIED; renews the send gate's evidence)
   * or "failed" (no usable answer; renews nothing). Omitted: no read.
   */
  check?: "checked" | "verified" | "failed"
  failureKind?: A2pCheckFailureKind
}

/**
 * Why a status check got no usable answer. Never a carrier state: SUSPENDED
 * and FAILED are statuses the provider reported, not failures to check.
 */
export type A2pCheckFailureKind = "provider_unreachable" | "provider_error"

/** Timeouts, network errors, 5xx and 429 are "unreachable"; any other refusal is an "error". */
export function a2pCheckFailureKind(err: unknown): A2pCheckFailureKind {
  if (err instanceof TwilioError) return err.status >= 500 || err.status === 429 ? "provider_unreachable" : "provider_error"
  return "provider_unreachable"
}

/**
 * Releases the claim and, in one transaction, writes the registration
 * status and shops.a2p_status (R7). False when the claim was already lost.
 */
async function finishA2p(supabase: SupabaseClient, shopId: string, token: string, finish: A2pFinish = {}): Promise<boolean> {
  const { data, error } = await supabase.rpc("a2p_finish_registration", {
    p_shop_id: shopId,
    p_token: token,
    p_status: finish.status ?? null,
    p_shop_status: finish.shopStatus ?? null,
    p_patch: finish.patch ?? {},
    p_check: finish.check ?? null,
    p_failure_kind: finish.failureKind ?? null,
  })
  if (error) console.error("[telephony] a2p finish failed:", error)
  return !error && data === true
}

const CLEARED = { failure_reason: null, failed_step: null, retryable: null } as const

/**
 * Submits (or resumes, or resubmits) carrier registration for the shop's
 * Gradia number: customer profile → A2P trust product → brand, under the
 * shop's subaccount (skill: do not reorder). See CHANNEL_PROVIDERS.md.
 *
 * Single-flight: the registration is claimed before any provider call, and
 * every checkpoint is written only while the claim is held, so a double
 * submit creates one profile and one brand; the loser is told a submission
 * is already in progress.
 *
 * Resumable: each step's SID is saved the moment it exists. Submitting the
 * same details again after a temporary failure continues after the last
 * completed step instead of creating a second profile or brand.
 *   - With carriers (brand/campaign pending), approved or suspended:
 *     refused; nothing is created.
 *   - Rejected brand, or changed details: a fresh chain (TrustHub bundles
 *     are immutable once reviewed).
 *   - Rejected campaign with the same details: the approved brand and the
 *     failed campaign are kept; the next status check edits and resubmits
 *     that campaign instead of creating a new one.
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

  const readRow = async () => {
    const { data, error } = await supabase.from("a2p_registrations").select("*").eq("shop_id", shop.id).maybeSingle()
    return { row: (data as A2pRegistrationRow | null) ?? null, error }
  }
  const refusal = (row: A2pRegistrationRow | null): A2pStartResult | null => {
    if (!row) return null
    if (row.status === "approved") return { ok: false, error: "Texting is already approved for this number." }
    if (row.status === "suspended") return { ok: false, error: "Carriers suspended texting on this number. Contact support — resubmitting won't lift a suspension." }
    if (row.status === "brand_pending" || row.status === "campaign_pending") {
      return { ok: false, error: "Your registration is already with the carriers. Check status instead of submitting again." }
    }
    return null
  }

  const first = await readRow()
  if (first.error) return { ok: false, error: "Couldn't read your registration — try again." }
  const early = refusal(first.row)
  if (early) return early
  if (!first.row) {
    // A placeholder row to claim. A concurrent first submit inserts nothing.
    const { error } = await supabase.from("a2p_registrations")
      .upsert({ shop_id: shop.id, status: "draft", business }, { onConflict: "shop_id", ignoreDuplicates: true })
    if (error) {
      console.error("[telephony] a2p insert failed:", error)
      return { ok: false, error: "Couldn't save your details — try again." }
    }
  }

  const token = await claimA2p(supabase, shop.id, ["draft", "rejected"])
  const claimed = await readRow()
  if (!token) {
    return refusal(claimed.row) ?? {
      ok: false,
      error: "A submission for this number is already in progress. Wait a minute, then check status.",
    }
  }
  const existing = claimed.row
  if (claimed.error || !existing) {
    await finishA2p(supabase, shop.id, token)
    return { ok: false, error: "Couldn't read your registration — try again." }
  }

  const sameDetails = sameBusinessDetails(existing.business, business)
  // A placeholder row inserted just now has attempts 0, so this counts as the first.
  const attempt = { attempts: (existing.attempts ?? 0) + 1, last_attempt_at: new Date().toISOString(), ...CLEARED }
  const statusCallback = `${origin}/api/twilio/a2p/status?shop=${encodeURIComponent(shop.id)}`
  let step: A2pRegistrationStep = "profile"
  try {
    // Carriers rejected only the campaign: keep the approved brand and the
    // failed campaign; the next status check edits and resubmits it (R5).
    if (existing.status === "rejected" && existing.failed_step === "campaign" && existing.brand_sid && sameDetails) {
      step = "campaign"
      await a2pUpdate(supabase, shop.id, token, step, attempt)
      if (!(await finishA2p(supabase, shop.id, token, { status: "brand_pending", shopStatus: "pending" }))) {
        return { ok: false, error: "Couldn't save your resubmission — try again." }
      }
      return { ok: true }
    }

    // Resume only a draft with the same details; anything else starts fresh.
    const resume = existing.status === "draft" && sameDetails
    const sids = resume
      ? { customer_profile_sid: existing.customer_profile_sid, trust_product_sid: existing.trust_product_sid, brand_sid: existing.brand_sid }
      : { customer_profile_sid: null, trust_product_sid: null, brand_sid: null }
    // Persist the submitted details first so a mid-pipeline failure never
    // loses the owner's form input.
    await a2pUpdate(supabase, shop.id, token, step, {
      status: "draft",
      business,
      ...sids,
      ...(resume ? {} : { messaging_service_sid: null, campaign_sid: null }),
      ...attempt,
    })

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
        await a2pUpdate(supabase, shop.id, token, step, { customer_profile_sid: customerProfileSid, trust_product_sid: trustProductSid })
      }
      step = "brand"
      if (!brandSid) {
        brandSid = (await createSoleProprietorBrand(creds, { customerProfileSid, trustProductSid })).brandSid
        await a2pUpdate(supabase, shop.id, token, step, { brand_sid: brandSid })
      }
    } else {
      if (!customerProfileSid) {
        customerProfileSid = (await registerBusinessProfile(creds, business, { primaryProfileSid, statusCallback, friendlyName: business.legal_name })).customerProfileSid
        await a2pUpdate(supabase, shop.id, token, step, { customer_profile_sid: customerProfileSid })
      }
      step = "trust_product"
      if (!trustProductSid) {
        trustProductSid = (await registerA2pTrustProduct(creds, {
          customerProfileSid,
          email: business.contact.email,
          friendlyName: `${business.legal_name} — A2P`,
          statusCallback,
        })).trustProductSid
        await a2pUpdate(supabase, shop.id, token, step, { trust_product_sid: trustProductSid })
      }
      step = "brand"
      if (!brandSid) {
        brandSid = (await createBrand(creds, { customerProfileSid, trustProductSid })).brandSid
        await a2pUpdate(supabase, shop.id, token, step, { brand_sid: brandSid })
      }
    }

    if (!(await finishA2p(supabase, shop.id, token, { status: "brand_pending", shopStatus: "pending" }))) {
      throw new A2pStepError(step, true, "Couldn't save registration progress. Try again; finished steps are kept.")
    }
    return { ok: true }
  } catch (err) {
    const failure = stepFailure(step, err)
    console.error(`[telephony] a2p registration failed at ${failure.step}:`, err)
    await finishA2p(supabase, shop.id, token, {
      patch: { failure_reason: failure.message, failed_step: failure.step, retryable: failure.retryable },
    })
    return { ok: false, error: failure.message }
  }
}

export type A2pSyncResult = {
  status: A2pRegistrationRow["status"]
  failureReason: string | null
}

/**
 * The same, plus what THIS call recorded: "answered" (the provider answered),
 * "failed" (it didn't answer usably) or null (no read was made or recorded,
 * e.g. another check held the claim). For the reconciler's scheduling.
 */
export type A2pSyncOutcome = { result: A2pSyncResult; check: "answered" | "failed" | null }

/** One status check; see syncA2pStatusDetailed below for what it does. */
export async function syncA2pStatus(input: {
  supabase: SupabaseClient
  shop: ShopTelephonyFields
  origin: string
}): Promise<A2pSyncResult> {
  return (await syncA2pStatusDetailed(input)).result
}

/**
 * Advances the registration pipeline one stage if Twilio has moved, and keeps
 * watching once approved:
 *   brand approved → messaging service (created once, inbound stays on
 *   Gradia's SMS handler) → campaign: one already on the service is adopted
 *   (a create whose response was lost) or, if it failed, edited and
 *   resubmitted; only when none exists is one created (R3, R5);
 *   campaign VERIFIED → attach the number and open the SMS gate (the ONLY
 *   place a2p_status becomes 'approved');
 *   approved or suspended → re-checked every time: SUSPENDED closes the gate
 *   as 'suspended', FAILED as 'rejected', anything else that isn't VERIFIED
 *   (PENDING, IN_PROGRESS, unknown) as pending (R4).
 * Single-flight: a check that can't take the claim makes no provider call
 * and reports the stored status. Status and the shop's gate are written in
 * one transaction (R7). A temporary failure is recorded and retried on the
 * next check; a stage is only reported as advanced once it is saved.
 */
export async function syncA2pStatusDetailed(input: {
  supabase: SupabaseClient
  shop: ShopTelephonyFields
  origin: string
}): Promise<A2pSyncOutcome> {
  const outcome = await syncOnce(input)
  return { result: { status: outcome.status, failureReason: outcome.failureReason }, check: outcome.check ?? null }
}

type InternalSyncResult = A2pSyncResult & { check?: "answered" | "failed" }

async function syncOnce(input: {
  supabase: SupabaseClient
  shop: ShopTelephonyFields
  origin: string
}): Promise<InternalSyncResult> {
  const { supabase, shop, origin } = input

  const read = async () => {
    const { data } = await supabase.from("a2p_registrations").select("*").eq("shop_id", shop.id).maybeSingle()
    return (data as A2pRegistrationRow | null) ?? null
  }
  const stored = await read()
  if (!stored) return { status: "draft", failureReason: null }
  const creds = subaccountCredsOrNull(shop)
  if (!creds || !(A2P_SYNC_STATUSES as readonly string[]).includes(stored.status)) {
    return { status: stored.status, failureReason: stored.failure_reason }
  }
  const token = await claimA2p(supabase, shop.id, A2P_SYNC_STATUSES)
  if (!token) return { status: stored.status, failureReason: stored.failure_reason }
  const reg = await read()
  if (!reg) {
    await finishA2p(supabase, shop.id, token)
    return { status: stored.status, failureReason: stored.failure_reason }
  }

  /** Whether this check got an answer from the provider (recorded as last_checked_at). */
  let answered = false
  /** Writes the outcome and releases the claim; a lost claim reports what's stored and renews nothing. */
  const finish = async (f: A2pFinish, result: A2pSyncResult): Promise<InternalSyncResult> => {
    const written = { check: answered ? ("checked" as const) : undefined, ...f }
    if (await finishA2p(supabase, shop.id, token, written)) {
      const check = written.check === "failed" ? "failed" : written.check ? "answered" : undefined
      return check ? { ...result, check } : result
    }
    const now = await read()
    return { status: now?.status ?? reg.status, failureReason: now?.failure_reason ?? null }
  }
  const unchanged = () => finish({}, { status: reg.status, failureReason: reg.failure_reason })
  const reject = (step: A2pRegistrationStep, reason: string) =>
    finish({ status: "rejected", shopStatus: "rejected", patch: { failure_reason: reason, failed_step: step, retryable: false } },
      { status: "rejected", failureReason: reason })

  let step: A2pRegistrationStep = reg.status === "brand_pending" ? "brand" : "campaign"
  try {
    if (reg.status === "brand_pending" && reg.brand_sid) {
      const brand = await getBrandStatus(creds, reg.brand_sid)
      answered = true
      if (brand.status === "FAILED") {
        return await reject("brand",
          brand.failureReason ??
            "Carriers couldn't verify the business — double-check the legal name matches the EIN exactly."
        )
      }
      if (brand.status !== "APPROVED") return await unchanged()

      step = "messaging_service"
      let messagingServiceSid = reg.messaging_service_sid
      if (!messagingServiceSid) {
        messagingServiceSid = (await createMessagingService(creds, {
          friendlyName: `${shop.name} — Gradia messaging`,
          inboundSmsUrl: `${origin}/api/twilio/sms`,
        })).messagingServiceSid
        await a2pUpdate(supabase, shop.id, token, step, { messaging_service_sid: messagingServiceSid })
      }

      step = "campaign"
      // Never create a campaign the service already has: adopt it, or edit
      // and resubmit it if it failed (one vetting fee per campaign).
      const onService = await listCampaigns(creds, messagingServiceSid)
      const existing =
        onService.find((c) => c.campaignSid === reg.campaign_sid) ??
        onService.find((c) => c.brandSid === reg.brand_sid) ??
        null
      let campaignSid: string
      if (existing) {
        campaignSid = existing.campaignSid
        if (existing.status === "FAILED") {
          await updateCampaign(creds, { messagingServiceSid, campaignSid, shopName: shop.name })
        }
      } else {
        campaignSid = (await createCampaign(creds, {
          messagingServiceSid,
          brandSid: reg.brand_sid,
          shopName: shop.name,
          useCase: reg.business?.has_ein === false ? "SOLE_PROPRIETOR" : "LOW_VOLUME",
        })).campaignSid
      }
      return await finish(
        { status: "campaign_pending", patch: { campaign_sid: campaignSid, ...CLEARED } },
        { status: "campaign_pending", failureReason: null }
      )
    }

    if (reg.status !== "brand_pending" && reg.messaging_service_sid && reg.campaign_sid) {
      const campaign = await getCampaignStatus(creds, reg.messaging_service_sid, reg.campaign_sid)
      answered = true
      if (campaign.status === "FAILED") {
        return await reject("campaign",
          campaign.errors ??
            "Carriers rejected the campaign — contact support and we'll adjust the registration."
        )
      }
      if (campaign.status === "SUSPENDED") {
        const reason = "Carriers suspended this number's texting campaign. Texting is paused — contact support, and don't send this traffic another way while it's under review."
        return await finish(
          { status: "suspended", shopStatus: "suspended", patch: { failure_reason: reason, failed_step: "campaign", retryable: false } },
          { status: "suspended", failureReason: reason }
        )
      }
      if (campaign.status !== "VERIFIED") {
        // PENDING, IN_PROGRESS or a status we don't know: texting stays closed.
        if (reg.status === "campaign_pending") return await unchanged()
        return await finish(
          { status: "campaign_pending", shopStatus: "pending", patch: CLEARED },
          { status: "campaign_pending", failureReason: null }
        )
      }

      step = "attach_number"
      if (reg.status !== "approved" && shop.gradia_number_sid) {
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
      // Writing the gate on every verified check also repairs a shop status
      // left behind by the old two-statement write, and renews the evidence.
      return await finish(
        { status: "approved", shopStatus: "approved", patch: CLEARED, check: "verified" },
        { status: "approved", failureReason: null }
      )
    }
    return await unchanged()
  } catch (err) {
    // Temporary: keep the current stage, record the step, retry on the next check.
    // An approved registration stays 'approved'; its evidence isn't renewed, so
    // the send gate closes as "check overdue" once it ages past the maximum.
    const failure = stepFailure(step, err)
    console.error(`[telephony] a2p sync failed at ${failure.step}:`, err)
    const reason = failure.retryable
      ? "A temporary problem stopped the next registration step. It will be retried on the next status check."
      : failure.message
    return await finish(
      {
        patch: { failed_step: failure.step, retryable: failure.retryable, failure_reason: reason },
        ...(answered ? {} : { check: "failed" as const, failureKind: a2pCheckFailureKind(err) }),
      },
      { status: reg.status, failureReason: reason }
    )
  }
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
 * approval backed by fresh evidence: a VERIFIED campaign read within the
 * maximum age (src/lib/a2p-evidence.ts). Any other number needs the owner's
 * attestation, which only `attest_byo_sms_registration` writes and a number
 * change clears (docs/architecture/BYO_SMS_ATTESTATION.md).
 */
export function smsGateForShop(
  shop: Pick<ShopRow, "gradia_number_e164" | "a2p_status" | "byo_sms_verified" | "a2p_verified_at">,
  fromNumber: string,
  now: Date = new Date()
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
  if (shop.a2p_status === "approved") {
    if (a2pEvidenceFresh(shop.a2p_verified_at, now)) return { allowed: true }
    return {
      allowed: false,
      reason: "Texting check overdue: Gradia hasn't confirmed this number's carrier approval recently, so texts are held until the next successful check.",
    }
  }
  return {
    allowed: false,
    reason:
      shop.a2p_status === "rejected"
        ? "Carrier registration was rejected — review your business details in Settings → Business Number."
        : shop.a2p_status === "suspended"
          ? "Carriers suspended texting on this number. Contact support before sending again."
          : "Your number is still being verified by carriers. Texting unlocks when it's approved.",
  }
}
