/**
 * Twilio A2P 10DLC vendor wrappers (TrustHub + Messaging APIs).
 *
 * Implementation detail behind telephony-provider.ts — nothing outside the
 * seam imports this module. All calls run under the SHOP SUBACCOUNT's
 * credentials (ISV model: registrations are per-subaccount), except where
 * noted. Sequence and field names verified against
 * twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
 * (2026-06-09) — the order is mandated by Twilio; do not reorder.
 *
 * Live-run note: policy SIDs below are Twilio's published well-known SIDs
 * for the secondary customer profile and A2P trust product policies. The
 * first live registration (needs master creds + TWILIO_PRIMARY_PROFILE_SID)
 * should confirm them before this ships.
 */

import { TwilioError, type TwilioCredentials } from "@/lib/twilio"
import type { A2pBusinessDetails } from "@/lib/types/database"

const TRUSTHUB_BASE =
  process.env.TWILIO_TRUSTHUB_API_BASE?.trim() || "https://trusthub.twilio.com/v1"
const MESSAGING_BASE =
  process.env.TWILIO_MESSAGING_API_BASE?.trim() || "https://messaging.twilio.com/v1"
const API_BASE =
  process.env.TWILIO_API_BASE?.trim() || "https://api.twilio.com/2010-04-01"

/** Well-known TrustHub policy SIDs (ISV onboarding docs). */
const SECONDARY_PROFILE_POLICY_SID = "RNdfbf3fae0e1107f8aded0e7cead80bf5"
const A2P_TRUST_PRODUCT_POLICY_SID = "RNb0d4771c2c98518d916a3d4cd70a8f8b"

async function call(
  creds: TwilioCredentials,
  method: "GET" | "POST",
  url: string,
  form?: Record<string, string>
): Promise<Record<string, unknown>> {
  const auth =
    "Basic " +
    Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      Accept: "application/json",
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new TwilioError(res.status, `${method} ${url} failed: ${raw.slice(0, 400)}`)
  }
  return JSON.parse(raw) as Record<string, unknown>
}

function requireSid(obj: Record<string, unknown>, what: string): string {
  const sid = typeof obj.sid === "string" ? obj.sid : null
  if (!sid) throw new TwilioError(500, `${what} response missing sid`)
  return sid
}

async function assignEntity(
  creds: TwilioCredentials,
  parentPath: "CustomerProfiles" | "TrustProducts",
  parentSid: string,
  objectSid: string
): Promise<void> {
  await call(
    creds,
    "POST",
    `${TRUSTHUB_BASE}/${parentPath}/${parentSid}/EntityAssignments`,
    { ObjectSid: objectSid }
  )
}

async function evaluateAndSubmit(
  creds: TwilioCredentials,
  parentPath: "CustomerProfiles" | "TrustProducts",
  parentSid: string,
  policySid: string,
  what: string
): Promise<void> {
  const evaluation = await call(
    creds,
    "POST",
    `${TRUSTHUB_BASE}/${parentPath}/${parentSid}/Evaluations`,
    { PolicySid: policySid }
  )
  if (evaluation.status !== "compliant") {
    // Surface which requirements failed — rejections here are fixable form
    // input problems (e.g. EIN/name mismatch), not server errors.
    const failed = JSON.stringify(evaluation.results ?? []).slice(0, 500)
    throw new TwilioError(400, `${what} failed Twilio's compliance check: ${failed}`)
  }
  await call(creds, "POST", `${TRUSTHUB_BASE}/${parentPath}/${parentSid}`, {
    Status: "pending-review",
  })
}

/**
 * Steps 1–9 of the ISV sequence: secondary customer profile with business
 * info, authorized rep, address, primary-profile link → evaluate → submit.
 */
export async function registerBusinessProfile(
  creds: TwilioCredentials,
  business: A2pBusinessDetails,
  opts: {
    /** Gradia's primary customer profile bundle (env, master account). */
    primaryProfileSid: string
    statusCallback: string
    friendlyName: string
  }
): Promise<{ customerProfileSid: string }> {
  const profile = await call(creds, "POST", `${TRUSTHUB_BASE}/CustomerProfiles`, {
    FriendlyName: opts.friendlyName,
    Email: business.contact.email,
    PolicySid: SECONDARY_PROFILE_POLICY_SID,
    StatusCallback: opts.statusCallback,
  })
  const profileSid = requireSid(profile, "CustomerProfile")

  const businessInfo = await call(creds, "POST", `${TRUSTHUB_BASE}/EndUsers`, {
    FriendlyName: `${business.legal_name} — business information`,
    Type: "customer_profile_business_information",
    Attributes: JSON.stringify({
      business_name: business.legal_name,
      business_type: business.business_type,
      business_industry: "AUTOMOTIVE",
      business_registration_identifier: "EIN",
      business_registration_number: business.ein,
      business_identity: "direct_customer",
      business_regions_of_operation: "USA_AND_CANADA",
      ...(business.website_url ? { website_url: business.website_url } : {}),
    }),
  })
  await assignEntity(creds, "CustomerProfiles", profileSid, requireSid(businessInfo, "EndUser"))

  const rep = await call(creds, "POST", `${TRUSTHUB_BASE}/EndUsers`, {
    FriendlyName: `${business.legal_name} — authorized representative`,
    Type: "authorized_representative_1",
    Attributes: JSON.stringify({
      first_name: business.contact.first_name,
      last_name: business.contact.last_name,
      email: business.contact.email,
      phone_number: business.contact.phone,
      business_title: business.contact.job_position,
      job_position: "Director",
    }),
  })
  await assignEntity(creds, "CustomerProfiles", profileSid, requireSid(rep, "EndUser"))

  const address = await call(
    creds,
    "POST",
    `${API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/Addresses.json`,
    {
      FriendlyName: `${business.legal_name} — business address`,
      CustomerName: business.legal_name,
      Street: business.address.street,
      City: business.address.city,
      Region: business.address.region,
      PostalCode: business.address.postal_code,
      IsoCountry: "US",
    }
  )
  const doc = await call(creds, "POST", `${TRUSTHUB_BASE}/SupportingDocuments`, {
    FriendlyName: `${business.legal_name} — address`,
    Type: "customer_profile_address",
    Attributes: JSON.stringify({ address_sids: requireSid(address, "Address") }),
  })
  await assignEntity(creds, "CustomerProfiles", profileSid, requireSid(doc, "SupportingDocument"))

  await assignEntity(creds, "CustomerProfiles", profileSid, opts.primaryProfileSid)

  await evaluateAndSubmit(
    creds,
    "CustomerProfiles",
    profileSid,
    SECONDARY_PROFILE_POLICY_SID,
    "Business profile"
  )
  return { customerProfileSid: profileSid }
}

/** A2P trust product bundle linked to the customer profile → submit. */
export async function registerA2pTrustProduct(
  creds: TwilioCredentials,
  input: {
    customerProfileSid: string
    email: string
    friendlyName: string
    statusCallback: string
  }
): Promise<{ trustProductSid: string }> {
  const product = await call(creds, "POST", `${TRUSTHUB_BASE}/TrustProducts`, {
    FriendlyName: input.friendlyName,
    Email: input.email,
    PolicySid: A2P_TRUST_PRODUCT_POLICY_SID,
    StatusCallback: input.statusCallback,
  })
  const productSid = requireSid(product, "TrustProduct")

  const profileInfo = await call(creds, "POST", `${TRUSTHUB_BASE}/EndUsers`, {
    FriendlyName: `${input.friendlyName} — messaging profile`,
    Type: "us_a2p_messaging_profile_information",
    Attributes: JSON.stringify({ company_type: "private" }),
  })
  await assignEntity(creds, "TrustProducts", productSid, requireSid(profileInfo, "EndUser"))
  await assignEntity(creds, "TrustProducts", productSid, input.customerProfileSid)

  await evaluateAndSubmit(
    creds,
    "TrustProducts",
    productSid,
    A2P_TRUST_PRODUCT_POLICY_SID,
    "A2P messaging profile"
  )
  return { trustProductSid: productSid }
}

/** Low-Volume Standard brand from the two submitted bundles. */
export async function createBrand(
  creds: TwilioCredentials,
  input: { customerProfileSid: string; trustProductSid: string }
): Promise<{ brandSid: string }> {
  const brand = await call(creds, "POST", `${MESSAGING_BASE}/a2p/BrandRegistrations`, {
    CustomerProfileBundleSid: input.customerProfileSid,
    A2PProfileBundleSid: input.trustProductSid,
    SkipAutomaticSecVet: "true", // Low-Volume Standard skips the paid vetting
  })
  return { brandSid: requireSid(brand, "BrandRegistration") }
}

export type BrandStatus = {
  status: "APPROVED" | "FAILED" | "PENDING"
  failureReason: string | null
}

export async function getBrandStatus(
  creds: TwilioCredentials,
  brandSid: string
): Promise<BrandStatus> {
  const brand = await call(
    creds,
    "GET",
    `${MESSAGING_BASE}/a2p/BrandRegistrations/${brandSid}`
  )
  const raw = typeof brand.status === "string" ? brand.status.toUpperCase() : ""
  const status =
    raw === "APPROVED" ? "APPROVED" : raw === "FAILED" ? "FAILED" : "PENDING"
  return {
    status,
    failureReason:
      typeof brand.failure_reason === "string" && brand.failure_reason
        ? brand.failure_reason
        : null,
  }
}

/** Messaging service with inbound routed to Gradia's existing SMS handler. */
export async function createMessagingService(
  creds: TwilioCredentials,
  input: { friendlyName: string; inboundSmsUrl: string }
): Promise<{ messagingServiceSid: string }> {
  const service = await call(creds, "POST", `${MESSAGING_BASE}/Services`, {
    FriendlyName: input.friendlyName,
    InboundRequestUrl: input.inboundSmsUrl,
    InboundMethod: "POST",
  })
  return { messagingServiceSid: requireSid(service, "MessagingService") }
}

/**
 * The campaign. Samples must look like real Gradia drafts — vague samples
 * are a top rejection cause. Customer-care/mixed traffic at detailer volume
 * fits the LOW_VOLUME use case.
 */
export async function createCampaign(
  creds: TwilioCredentials,
  input: {
    messagingServiceSid: string
    brandSid: string
    shopName: string
  }
): Promise<{ campaignSid: string }> {
  const campaign = await call(
    creds,
    "POST",
    `${MESSAGING_BASE}/Services/${input.messagingServiceSid}/Compliance/Usa2p`,
    {
      BrandRegistrationSid: input.brandSid,
      UsAppToPersonUsecase: "LOW_VOLUME",
      Description: `Customer care and appointment messaging for ${input.shopName}, an auto detailing business: quote follow-ups, booking confirmations, appointment reminders, and replies to customer questions. All recipients are existing customers or people who contacted the business first.`,
      MessageFlow:
        "Customers opt in by texting or calling the business first, or by providing their phone number when requesting a quote or booking an appointment (by phone, web form, or in person). Opt-in is confirmed in the first reply, and every message supports STOP to unsubscribe and HELP for assistance.",
      "MessageSamples": JSON.stringify([
        `Hi Jordan — confirming your interior detail this Saturday at 3pm. Reply YES to confirm or STOP to opt out. — Gradia at ${input.shopName}`,
        `Hi Sam, following up on the ceramic coating quote we sent over. Want us to hold a spot next week? Reply STOP to opt out. — Gradia at ${input.shopName}`,
      ]),
      HasEmbeddedLinks: "false",
      HasEmbeddedPhone: "false",
      OptOutKeywords: JSON.stringify(["STOP"]),
      HelpKeywords: JSON.stringify(["HELP"]),
    }
  )
  return { campaignSid: requireSid(campaign, "Usa2p campaign") }
}

export type CampaignStatus = {
  status: "VERIFIED" | "FAILED" | "PENDING"
  errors: string | null
}

export async function getCampaignStatus(
  creds: TwilioCredentials,
  messagingServiceSid: string,
  campaignSid: string
): Promise<CampaignStatus> {
  const campaign = await call(
    creds,
    "GET",
    `${MESSAGING_BASE}/Services/${messagingServiceSid}/Compliance/Usa2p/${campaignSid}`
  )
  const raw =
    typeof campaign.campaign_status === "string"
      ? campaign.campaign_status.toUpperCase()
      : ""
  const status =
    raw === "VERIFIED" ? "VERIFIED" : raw === "FAILED" ? "FAILED" : "PENDING"
  return {
    status,
    errors: campaign.errors ? JSON.stringify(campaign.errors).slice(0, 500) : null,
  }
}

/** Final step: the number joins the campaign's messaging service. */
export async function attachNumberToMessagingService(
  creds: TwilioCredentials,
  input: { messagingServiceSid: string; phoneNumberSid: string }
): Promise<void> {
  await call(
    creds,
    "POST",
    `${MESSAGING_BASE}/Services/${input.messagingServiceSid}/PhoneNumbers`,
    { PhoneNumberSid: input.phoneNumberSid }
  )
}
