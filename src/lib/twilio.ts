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

function authToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN?.trim() || null
}

/**
 * Verifies the X-Twilio-Signature header. Returns false if the auth
 * token isn't configured (fail closed). The URL must be the public
 * URL Twilio actually called — pass the value derived from the
 * request, accounting for any proxy / Vercel host rewriting.
 */
export function verifyTwilioSignature(input: {
  url: string
  form: URLSearchParams
  signature: string | null
}): boolean {
  const token = authToken()
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

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01"

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
 * Sends an outbound SMS via Twilio's Messages API.
 * Endpoint: POST /2010-04-01/Accounts/{AccountSid}/Messages.json,
 * Basic auth with AccountSid:AuthToken, form-encoded body.
 *
 * Caller is responsible for HITL — this is the raw API wrapper. The
 * approval engine calls it after a `send_sms` pending_action is
 * approved; the operator Quick Reply server action calls it directly
 * (operator is the human, HITL satisfied).
 */
export async function sendOutboundSms(input: {
  from: string
  to: string
  body: string
}): Promise<TwilioSendResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim()
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim()
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
