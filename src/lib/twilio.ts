/**
 * Twilio webhook utilities (server-only).
 *
 * Pilot auth model: one global Twilio account (TWILIO_ACCOUNT_SID +
 * TWILIO_AUTH_TOKEN in env), each shop owns one phone number on it.
 * Signature verification uses the global auth token, so all shops'
 * inbound traffic flows through this one endpoint.
 *
 * Signature algorithm (HMAC-SHA1, base64):
 *   1. Take the full request URL (the one Twilio called).
 *   2. Append each form parameter sorted alphabetically by key:
 *      sortedKey1 + sortedValue1 + sortedKey2 + sortedValue2 + ...
 *   3. HMAC-SHA1 the resulting string with the auth token.
 *   4. Base64-encode the digest; compare to X-Twilio-Signature.
 *
 * Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export type TwilioInboundSms = {
  messageSid: string
  accountSid: string
  from: string
  to: string
  body: string
  numMedia: number
  fromCity: string | null
  fromState: string | null
  fromCountry: string | null
}

/**
 * Parses Twilio's application/x-www-form-urlencoded webhook body into
 * a flat, typed shape. Unknown fields (MediaUrl0, MediaUrl1, …, plus
 * shortcode / WhatsApp specific keys) pass through `raw` for handlers
 * that need them.
 */
export function parseInboundSms(form: URLSearchParams): {
  parsed: TwilioInboundSms
  raw: Record<string, string>
} {
  const raw: Record<string, string> = {}
  for (const [k, v] of form.entries()) {
    raw[k] = v
  }
  const numMedia = Number.parseInt(raw.NumMedia ?? "0", 10) || 0
  return {
    parsed: {
      messageSid: raw.MessageSid ?? raw.SmsSid ?? "",
      accountSid: raw.AccountSid ?? "",
      from: raw.From ?? "",
      to: raw.To ?? "",
      body: raw.Body ?? "",
      numMedia,
      fromCity: raw.FromCity || null,
      fromState: raw.FromState || null,
      fromCountry: raw.FromCountry || null,
    },
    raw,
  }
}

function envAuthToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN?.trim() || null
}

function envAccountSid(): string | null {
  return process.env.TWILIO_ACCOUNT_SID?.trim() || null
}

import { tryDecryptSecret } from "@/lib/crypto"
import type { ShopRow } from "@/lib/types/database"

export type TwilioCredentials = {
  accountSid: string
  authToken: string
  /**
   * Which credential class resolveTwilioCredentials picked. Optional so
   * hand-built credentials (A2P route, tests) stay valid; used for
   * structured logging on webhook verification — never log the token.
   */
  source?: "subaccount" | "byo" | "env"
}

type ShopCredFields = Partial<
  Pick<
    ShopRow,
    | "twilio_account_sid_enc"
    | "twilio_auth_token_enc"
    | "twilio_subaccount_sid"
    | "twilio_subaccount_token_enc"
    | "twilio_phone_number"
    | "gradia_number_e164"
  >
>

/**
 * Resolves the Twilio credentials to use for a given shop, in order:
 *
 * 1. The shop's Gradia subaccount — when the shop's active number IS the
 *    Gradia-provisioned one. That number only exists on the subaccount, so
 *    sends from it and inbound signature verification for it must use the
 *    subaccount token, never the master account's.
 * 2. BYO credentials (encrypted on the shop row).
 * 3. The pilot-mode global env account.
 *
 * Returns null when no credentials are available anywhere — callers
 * should treat that as "Twilio not configured."
 */
export function resolveTwilioCredentials(
  shop: ShopCredFields | null | undefined
): TwilioCredentials | null {
  const subToken = tryDecryptSecret(shop?.twilio_subaccount_token_enc)
  const gradiaNumberActive =
    Boolean(shop?.gradia_number_e164) &&
    shop?.twilio_phone_number === shop?.gradia_number_e164
  if (shop?.twilio_subaccount_sid && subToken && gradiaNumberActive) {
    return {
      accountSid: shop.twilio_subaccount_sid,
      authToken: subToken,
      source: "subaccount",
    }
  }
  const shopSid = tryDecryptSecret(shop?.twilio_account_sid_enc)
  const shopToken = tryDecryptSecret(shop?.twilio_auth_token_enc)
  if (shopSid && shopToken) {
    return { accountSid: shopSid, authToken: shopToken, source: "byo" }
  }
  const envSid = envAccountSid()
  const envToken = envAuthToken()
  if (envSid && envToken) {
    return { accountSid: envSid, authToken: envToken, source: "env" }
  }
  return null
}

/**
 * Verifies the X-Twilio-Signature header. Returns false if the
 * auth token isn't configured (fail closed). The URL must be the
 * public URL Twilio actually called — pass the value derived from
 * the request, accounting for any proxy / Vercel host rewriting.
 *
 * When `creds` is provided, signature is verified against that auth
 * token. Otherwise the env-global token is used (legacy single-tenant
 * mode). Callers that resolve the shop after parsing the form should
 * pass the per-shop creds in to keep BYO shops verifiable.
 */
export function verifyTwilioSignature(input: {
  url: string
  form: URLSearchParams
  signature: string | null
  creds?: TwilioCredentials | null
}): boolean {
  const token = input.creds?.authToken ?? envAuthToken()
  if (!token) return false
  if (!input.signature) return false

  // Sorted alphabetically by key.
  const keys = Array.from(input.form.keys()).sort()
  let signedString = input.url
  for (const k of keys) {
    signedString += k + (input.form.get(k) ?? "")
  }

  const expected = createHmac("sha1", token)
    .update(signedString)
    .digest("base64")

  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature.trim())
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Empty TwiML response — tells Twilio "received, nothing to send back."
 * We never auto-reply: per OPERATIONS.md, every outbound message goes
 * through HITL.
 */
export const EMPTY_TWIML_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`

// Env-overridable so tests can point the executor at a mock server.
const TWILIO_API_BASE =
  process.env.TWILIO_API_BASE?.trim() || "https://api.twilio.com/2010-04-01"

export class TwilioError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "TwilioError"
  }
}

export type TwilioSendResult = {
  messageSid: string
  status: string | null
}

/**
 * Builds the public URL Twilio should call back on delivery status
 * transitions. Returns null when GRADIA_DASHBOARD_URL isn't set —
 * sends without a callback still work, the status just freezes at
 * the initial value the create-response returned.
 */
export function defaultStatusCallbackUrl(shopId?: string): string | null {
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (!configured) return null
  try {
    const base = `${new URL(configured).origin}/api/twilio/sms/status`
    return shopId
      ? `${base}?shop=${encodeURIComponent(shopId)}`
      : base
  } catch {
    return null
  }
}

/**
 * Sends an outbound SMS via Twilio's Messages API.
 * Endpoint: POST /2010-04-01/Accounts/{AccountSid}/Messages.json,
 * Basic auth with AccountSid:AuthToken, form-encoded body.
 *
 * Caller is responsible for HITL — this is the raw API wrapper. The
 * approval engine calls it after a `send_sms` pending_action is
 * approved; the operator Quick Reply server action calls it directly
 * (operator is the human, HITL satisfied).
 */
// ---------- Phone number provisioning ----------

export type TwilioAvailableNumber = {
  /** E.164 number, ready to provision. */
  phoneNumber: string
  /** Human-readable form, e.g. "(617) 555-0142". */
  friendlyName: string
  locality: string | null
  region: string | null
}

type RawAvailableNumber = {
  phone_number?: string
  friendly_name?: string
  locality?: string | null
  region?: string | null
}

/**
 * Searches Twilio's pool of available local numbers. `areaCode` is
 * optional — when omitted Twilio returns nearby/popular options for the
 * given country. Pilot defaults country to US.
 *
 * Docs:
 *   https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource
 */
export async function searchAvailableNumbers(input: {
  /** ISO-3166-1 alpha-2 (default "US"). */
  country?: string
  /** 3-digit area code, e.g. "617". */
  areaCode?: string
  limit?: number
  /** Override Gradia's master Twilio creds (rare — BYO shops). */
  creds?: TwilioCredentials | null
}): Promise<TwilioAvailableNumber[]> {
  const accountSid = input.creds?.accountSid ?? envAccountSid()
  const authToken = input.creds?.authToken ?? envAuthToken()
  if (!accountSid || !authToken) {
    throw new TwilioError(500, "Twilio credentials missing")
  }

  const country = (input.country ?? "US").toUpperCase()
  const url = new URL(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json`
  )
  url.searchParams.set("SmsEnabled", "true")
  url.searchParams.set("VoiceEnabled", "true")
  url.searchParams.set("PageSize", String(input.limit ?? 8))
  if (input.areaCode?.trim()) {
    url.searchParams.set("AreaCode", input.areaCode.trim())
  }

  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new TwilioError(
      res.status,
      `Twilio number search failed: ${raw.slice(0, 300)}`
    )
  }
  const parsed = JSON.parse(raw) as {
    available_phone_numbers?: RawAvailableNumber[]
  }
  return (parsed.available_phone_numbers ?? [])
    .filter((n): n is RawAvailableNumber & { phone_number: string } =>
      Boolean(n.phone_number)
    )
    .map((n) => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name?.trim() || n.phone_number,
      locality: n.locality?.trim() || null,
      region: n.region?.trim() || null,
    }))
}

export type TwilioProvisionedNumber = {
  /** PN... incoming-phone-number sid. */
  sid: string
  phoneNumber: string
}

/**
 * Buys (provisions) a phone number on the account and wires it up for
 * inbound SMS. The SmsUrl webhook is what Twilio POSTs to whenever a
 * text comes in.
 *
 * Idempotent only via Twilio's own deduplication — calling twice with
 * the same number returns 400 since it's already provisioned. Callers
 * should treat that as success and look up the existing sid via the
 * IncomingPhoneNumbers list endpoint if they need it.
 */
export async function provisionPhoneNumber(input: {
  phoneNumber: string
  /** Public URL Twilio should POST inbound SMS to. */
  smsUrl: string
  /** Optional status-callback for delivery transitions on outbound. */
  statusCallback?: string | null
  /** Friendly name shown in the Twilio console — defaults to the shop name. */
  friendlyName?: string | null
  creds?: TwilioCredentials | null
}): Promise<TwilioProvisionedNumber> {
  const accountSid = input.creds?.accountSid ?? envAccountSid()
  const authToken = input.creds?.authToken ?? envAuthToken()
  if (!accountSid || !authToken) {
    throw new TwilioError(500, "Twilio credentials missing")
  }
  if (!input.phoneNumber.trim()) {
    throw new TwilioError(400, "Phone number is required")
  }
  if (!input.smsUrl.trim()) {
    throw new TwilioError(400, "smsUrl is required so inbound texts reach us")
  }

  const form = new URLSearchParams({
    PhoneNumber: input.phoneNumber.trim(),
    SmsUrl: input.smsUrl.trim(),
    SmsMethod: "POST",
  })
  if (input.statusCallback) {
    form.set("StatusCallback", input.statusCallback)
    form.set("StatusCallbackMethod", "POST")
  }
  if (input.friendlyName?.trim()) {
    form.set("FriendlyName", input.friendlyName.trim())
  }

  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")

  const res = await fetch(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json`,
    {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    }
  )
  const raw = await res.text()
  if (!res.ok) {
    throw new TwilioError(
      res.status,
      `Twilio provision failed: ${raw.slice(0, 300)}`
    )
  }
  const parsed = JSON.parse(raw) as {
    sid?: string
    phone_number?: string
  }
  if (!parsed.sid || !parsed.phone_number) {
    throw new TwilioError(500, "Twilio provision response missing sid")
  }
  return {
    sid: parsed.sid,
    phoneNumber: parsed.phone_number,
  }
}

/**
 * Finds the IncomingPhoneNumber sid for a given E.164 number. Used to
 * resolve the sid for an already-provisioned number when we want to
 * release it or update its webhook config.
 */
export async function findIncomingPhoneNumberSid(input: {
  phoneNumber: string
  creds?: TwilioCredentials | null
}): Promise<string | null> {
  const accountSid = input.creds?.accountSid ?? envAccountSid()
  const authToken = input.creds?.authToken ?? envAuthToken()
  if (!accountSid || !authToken) return null

  const url = new URL(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers.json`
  )
  url.searchParams.set("PhoneNumber", input.phoneNumber)

  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  })
  if (!res.ok) return null
  const parsed = (await res.json()) as {
    incoming_phone_numbers?: Array<{ sid?: string }>
  }
  return parsed.incoming_phone_numbers?.[0]?.sid ?? null
}

/**
 * Releases (deletes) an IncomingPhoneNumber from the account. Stops
 * the per-month rental charge. Called from disconnect when the
 * operator explicitly wants to drop the number, not just unwire it.
 */
export async function releasePhoneNumber(input: {
  sid: string
  creds?: TwilioCredentials | null
}): Promise<void> {
  const accountSid = input.creds?.accountSid ?? envAccountSid()
  const authToken = input.creds?.authToken ?? envAuthToken()
  if (!accountSid || !authToken) {
    throw new TwilioError(500, "Twilio credentials missing")
  }

  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")

  const res = await fetch(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(input.sid)}.json`,
    {
      method: "DELETE",
      headers: { Authorization: auth },
    }
  )
  if (!res.ok && res.status !== 404) {
    const raw = await res.text()
    throw new TwilioError(
      res.status,
      `Twilio release failed: ${raw.slice(0, 300)}`
    )
  }
}

export async function sendOutboundSms(input: {
  from: string
  to: string
  body: string
  statusCallback?: string | null
  /** Per-shop Twilio credentials. When absent, falls back to env. */
  creds?: TwilioCredentials | null
}): Promise<TwilioSendResult> {
  const accountSid = input.creds?.accountSid ?? envAccountSid()
  const authToken = input.creds?.authToken ?? envAuthToken()
  if (!accountSid || !authToken) {
    throw new TwilioError(500, "TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing")
  }

  const trimmedBody = input.body.trim()
  if (!trimmedBody) throw new TwilioError(400, "SMS body is empty")
  if (!input.from) throw new TwilioError(400, "Missing sender number")
  if (!input.to) throw new TwilioError(400, "Missing recipient number")

  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")

  const form = new URLSearchParams({
    From: input.from,
    To: input.to,
    Body: trimmedBody,
  })
  if (input.statusCallback) {
    form.set("StatusCallback", input.statusCallback)
  }

  const res = await fetch(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    }
  )

  const raw = await res.text()
  if (!res.ok) {
    throw new TwilioError(res.status, `SMS send failed: ${raw.slice(0, 300)}`)
  }
  const obj = JSON.parse(raw) as { sid?: string; status?: string }
  if (!obj.sid) {
    throw new TwilioError(500, "SMS send response missing sid")
  }
  return { messageSid: obj.sid, status: obj.status ?? null }
}

/**
 * Reads a number's current webhook wiring. Used after a Vapi import to
 * verify the messaging webhook still points at Gradia (the voice/SMS
 * split), and by the spike script.
 */
export async function getIncomingPhoneNumberConfig(input: {
  sid: string
  creds?: TwilioCredentials | null
}): Promise<{ voiceUrl: string; smsUrl: string } | null> {
  const accountSid = input.creds?.accountSid ?? envAccountSid()
  const authToken = input.creds?.authToken ?? envAuthToken()
  if (!accountSid || !authToken) return null

  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")
  const res = await fetch(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(input.sid)}.json`,
    { headers: { Authorization: auth, Accept: "application/json" } }
  )
  if (!res.ok) return null
  const parsed = (await res.json()) as {
    voice_url?: string | null
    sms_url?: string | null
  }
  return { voiceUrl: parsed.voice_url ?? "", smsUrl: parsed.sms_url ?? "" }
}

/** Re-points a number's MESSAGING webhook (voice config untouched). */
export async function setNumberSmsWebhook(input: {
  sid: string
  smsUrl: string
  creds?: TwilioCredentials | null
}): Promise<void> {
  const accountSid = input.creds?.accountSid ?? envAccountSid()
  const authToken = input.creds?.authToken ?? envAuthToken()
  if (!accountSid || !authToken) {
    throw new TwilioError(500, "Twilio credentials missing")
  }
  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")
  const res = await fetch(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(input.sid)}.json`,
    {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        SmsUrl: input.smsUrl,
        SmsMethod: "POST",
      }).toString(),
    }
  )
  if (!res.ok) {
    const raw = await res.text()
    throw new TwilioError(
      res.status,
      `SmsUrl re-set failed: ${raw.slice(0, 300)}`
    )
  }
}

// ---------- Subaccounts (ISV model) ----------

export type TwilioSubaccount = {
  sid: string
  authToken: string
}

/**
 * Creates a subaccount under the master (env) account — the ISV model's
 * per-shop isolation boundary (deliverability, A2P registration, usage
 * records). Master credentials only; a subaccount can't create siblings.
 *
 * Created on FIRST NUMBER PURCHASE, never at signup — callers go through
 * telephony-provider.ts `ensureSubaccount`, which handles idempotency and
 * encrypted storage.
 *
 * Docs: https://www.twilio.com/docs/iam/api/subaccounts
 */
export async function createSubaccount(input: {
  /** FriendlyName for the Twilio console — use the shop id. */
  friendlyName: string
}): Promise<TwilioSubaccount> {
  const accountSid = envAccountSid()
  const authToken = envAuthToken()
  if (!accountSid || !authToken) {
    throw new TwilioError(500, "Master Twilio credentials missing")
  }
  if (!input.friendlyName.trim()) {
    throw new TwilioError(400, "friendlyName is required")
  }

  const auth =
    "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64")

  const res = await fetch(`${TWILIO_API_BASE}/Accounts.json`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      FriendlyName: input.friendlyName.trim(),
    }).toString(),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new TwilioError(
      res.status,
      `Twilio subaccount create failed: ${raw.slice(0, 300)}`
    )
  }
  const parsed = JSON.parse(raw) as { sid?: string; auth_token?: string }
  if (!parsed.sid || !parsed.auth_token) {
    throw new TwilioError(500, "Twilio subaccount response missing sid/token")
  }
  return { sid: parsed.sid, authToken: parsed.auth_token }
}

// ---------- Usage Records (reconciliation) ----------

/**
 * Month-to-date spend on an account in cents, from Twilio's Usage Records
 * API (`Category=totalprice` covers every product — calls, SMS, number
 * rentals). The reconciliation job compares this against the ledger's
 * wholesale totals per subaccount; calendar-month alignment is why the
 * ledger side also sums month-to-date.
 *
 * Docs: https://www.twilio.com/docs/usage/api/usage-record
 */
export async function fetchMonthToDateUsageCents(
  creds: TwilioCredentials
): Promise<number> {
  const auth =
    "Basic " +
    Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")
  const url = new URL(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(creds.accountSid)}/Usage/Records/ThisMonth.json`
  )
  url.searchParams.set("Category", "totalprice")

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new TwilioError(
      res.status,
      `Twilio usage fetch failed: ${raw.slice(0, 300)}`
    )
  }
  const parsed = JSON.parse(raw) as {
    usage_records?: Array<{ price?: string | number | null }>
  }
  const priceUsd = Number(parsed.usage_records?.[0]?.price ?? 0)
  return Number.isFinite(priceUsd) ? priceUsd * 100 : 0
}
