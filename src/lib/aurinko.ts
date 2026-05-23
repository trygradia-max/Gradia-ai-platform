/**
 * Aurinko API client (server-only).
 *
 * Aurinko is a unified email API — they handle the Gmail/Outlook OAuth
 * dance and give us one webhook stream for inbound messages. The flow:
 *
 *   1. /api/aurinko/auth/start redirects the user to Aurinko's hosted
 *      authorize page with our client credentials and a state nonce.
 *   2. Aurinko sends the user through Gmail OAuth, then redirects to
 *      /api/aurinko/auth/callback?code=...&state=...
 *   3. The callback exchanges the code for an account access token,
 *      reads the account info, and creates a /email/messages
 *      subscription pointed at /api/aurinko/webhook.
 *   4. When new mail arrives, Aurinko POSTs to our webhook with the
 *      message ID. We fetch the message and route it through the HITL
 *      lead-capture flow.
 *
 * Docs: https://docs.aurinko.io
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import { encryptSecret, tryDecryptSecret } from "@/lib/crypto"
import type { ShopRow } from "@/lib/types/database"

const AURINKO_API_BASE = "https://api.aurinko.io/v1"
const REFRESH_BUFFER_MS = 60 * 1000 // refresh when within 60s of expiry

export class AurinkoError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "AurinkoError"
  }
}

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.AURINKO_CLIENT_ID?.trim()
  const clientSecret = process.env.AURINKO_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing AURINKO_CLIENT_ID or AURINKO_CLIENT_SECRET"
    )
  }
  return { clientId, clientSecret }
}

function basicAuthHeader(): string {
  const { clientId, clientSecret } = clientCredentials()
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
}

/**
 * Builds the hosted authorize URL. The user gets redirected here from
 * /api/aurinko/auth/start; Aurinko owns the Gmail OAuth UI itself.
 */
/**
 * Default scope set — covers inbound email, outbound email, and full
 * calendar access. Existing shops that connected before Calendar
 * support shipped will need to disconnect + reconnect to grant the
 * new scopes.
 */
const DEFAULT_SCOPES = "Mail.Read Mail.ReadWrite Mail.Send Calendar.ReadWrite"

export function buildAuthorizeUrl(input: {
  returnUrl: string
  state: string
  serviceType?: string
  scopes?: string
}): string {
  const { clientId } = clientCredentials()
  const params = new URLSearchParams({
    clientId,
    serviceType: input.serviceType ?? "Google",
    scopes: input.scopes ?? DEFAULT_SCOPES,
    responseType: "code",
    returnUrl: input.returnUrl,
    state: input.state,
  })
  return `${AURINKO_API_BASE}/auth/authorize?${params.toString()}`
}

export type AurinkoTokenResponse = {
  accountId: number
  accessToken: string
  /** Absolute ISO expiry, or null when Aurinko didn't supply one. */
  expiresAt: string | null
}

function readExpiry(parsed: unknown): string | null {
  const obj = parsed as { expiresIn?: unknown; expires_in?: unknown }
  const seconds =
    typeof obj.expiresIn === "number"
      ? obj.expiresIn
      : typeof obj.expires_in === "number"
        ? obj.expires_in
        : null
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  return new Date(Date.now() + seconds * 1000).toISOString()
}

/**
 * Exchanges the authorization code for an account access token.
 * Endpoint: POST /v1/auth/token/{code} with Basic auth (clientId:secret).
 */
export async function exchangeAuthCode(code: string): Promise<AurinkoTokenResponse> {
  const res = await fetch(`${AURINKO_API_BASE}/auth/token/${encodeURIComponent(code)}`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      Accept: "application/json",
    },
  })

  const body = await res.text()
  if (!res.ok) {
    throw new AurinkoError(res.status, `Token exchange failed: ${body.slice(0, 200)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AurinkoError(500, "Token exchange returned non-JSON")
  }

  const obj = parsed as { accountId?: unknown; accessToken?: unknown }
  if (typeof obj.accountId !== "number" || typeof obj.accessToken !== "string") {
    throw new AurinkoError(500, "Token exchange missing accountId or accessToken")
  }

  return {
    accountId: obj.accountId,
    accessToken: obj.accessToken,
    expiresAt: readExpiry(parsed),
  }
}

/**
 * Refreshes the access token for a previously-linked Aurinko account.
 * Endpoint: POST /v1/auth/accessToken/{accountId} with the same Basic
 * auth we use for code exchange. Aurinko's model is "app credentials
 * + accountId = authority to mint a new token for that linked
 * account" — no separate refresh_token to track.
 */
export async function refreshAccessToken(
  accountId: number
): Promise<{ accessToken: string; expiresAt: string | null }> {
  const res = await fetch(
    `${AURINKO_API_BASE}/auth/accessToken/${accountId}`,
    {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        Accept: "application/json",
      },
    }
  )
  const body = await res.text()
  if (!res.ok) {
    throw new AurinkoError(
      res.status,
      `Token refresh failed: ${body.slice(0, 200)}`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AurinkoError(500, "Token refresh returned non-JSON")
  }
  const obj = parsed as { accessToken?: unknown }
  if (typeof obj.accessToken !== "string") {
    throw new AurinkoError(500, "Token refresh missing accessToken")
  }
  return {
    accessToken: obj.accessToken,
    expiresAt: readExpiry(parsed),
  }
}

export type AurinkoAccount = {
  id: number
  email: string | null
  serviceType: string | null
}

/**
 * Reads the account info attached to an access token. Endpoint: GET /v1/account.
 */
export async function getAccount(accessToken: string): Promise<AurinkoAccount> {
  const res = await fetch(`${AURINKO_API_BASE}/account`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })
  const body = await res.text()
  if (!res.ok) {
    throw new AurinkoError(res.status, `Account fetch failed: ${body.slice(0, 200)}`)
  }
  const obj = JSON.parse(body) as {
    id?: number
    email?: string | null
    serviceType?: string | null
  }
  if (typeof obj.id !== "number") {
    throw new AurinkoError(500, "Account response missing id")
  }
  return {
    id: obj.id,
    email: obj.email ?? null,
    serviceType: obj.serviceType ?? null,
  }
}

export type AurinkoSubscription = {
  id: string
  resource: string
  notificationUrl: string
}

/**
 * Creates a webhook subscription so Aurinko POSTs new email events to us.
 * Endpoint: POST /v1/subscriptions.
 */
export async function createMessagesSubscription(
  accessToken: string,
  notificationUrl: string
): Promise<AurinkoSubscription> {
  const res = await fetch(`${AURINKO_API_BASE}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      resource: "/email/messages",
      notificationUrl,
    }),
  })
  const body = await res.text()
  if (!res.ok) {
    throw new AurinkoError(res.status, `Subscription create failed: ${body.slice(0, 200)}`)
  }
  const obj = JSON.parse(body) as {
    id?: string | number
    resource?: string
    notificationUrl?: string
  }
  if (obj.id === undefined || !obj.resource || !obj.notificationUrl) {
    throw new AurinkoError(500, "Subscription response missing fields")
  }
  return {
    id: String(obj.id),
    resource: obj.resource,
    notificationUrl: obj.notificationUrl,
  }
}

/**
 * Best-effort delete on disconnect. Failures are logged, not thrown — we
 * still want to clear the shop's credentials locally even if Aurinko's
 * subscription is already gone.
 */
export async function deleteSubscription(
  accessToken: string,
  subscriptionId: string
): Promise<void> {
  try {
    await fetch(
      `${AURINKO_API_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    )
  } catch (err) {
    console.warn("[aurinko] subscription delete failed:", err)
  }
}

export type AurinkoMessage = {
  id: string
  subject: string | null
  bodyPlain: string | null
  fromName: string | null
  fromEmail: string | null
  receivedAt: string | null
}

type RawAurinkoAddress = { name?: string | null; address?: string | null }
type RawAurinkoMessage = {
  id?: string
  subject?: string | null
  bodyPlain?: string | null
  body?: string | null
  from?: RawAurinkoAddress | null
  sender?: RawAurinkoAddress | null
  receivedDateTime?: string | null
  receivedAt?: string | null
}

/**
 * Endpoint: GET /v1/email/messages/{id}. We normalize the response into
 * a small flat shape so the webhook handler doesn't care which provider
 * (Gmail/Outlook) is underneath.
 */
export async function getEmailMessage(
  accessToken: string,
  messageId: string
): Promise<AurinkoMessage> {
  const res = await fetch(
    `${AURINKO_API_BASE}/email/messages/${encodeURIComponent(messageId)}?bodyType=text`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  )
  const body = await res.text()
  if (!res.ok) {
    throw new AurinkoError(res.status, `Message fetch failed: ${body.slice(0, 200)}`)
  }
  const obj = JSON.parse(body) as RawAurinkoMessage
  const from = obj.from ?? obj.sender ?? null
  return {
    id: obj.id ?? messageId,
    subject: obj.subject ?? null,
    bodyPlain: obj.bodyPlain ?? obj.body ?? null,
    fromName: from?.name ?? null,
    fromEmail: from?.address ?? null,
    receivedAt: obj.receivedDateTime ?? obj.receivedAt ?? null,
  }
}

// ---------- outbound email ----------

export type AurinkoSentMessage = {
  id: string
}

/**
 * Sends an email from the connected mailbox.
 * Endpoint: POST /v1/email/messages.
 *
 * Body is plain text (bodyType=text). HTML support exists via the
 * `bodyType=html` query param — not used in the pilot drafter path,
 * which produces plain-text bodies on purpose (no formatting drift
 * across mail clients).
 *
 * Threading: Aurinko doesn't document an explicit reference-message
 * field, so this sends as a new message. The recipient sees a
 * standalone email rather than a threaded reply. Fine for pilot —
 * proper threading is a follow-up.
 */
export async function sendEmailMessage(
  accessToken: string,
  input: {
    subject: string
    body: string
    to: string
    cc?: string | null
  }
): Promise<AurinkoSentMessage> {
  const trimmedSubject = input.subject.trim()
  const trimmedBody = input.body.trim()
  if (!trimmedSubject) {
    throw new AurinkoError(400, "Email subject is empty")
  }
  if (!trimmedBody) {
    throw new AurinkoError(400, "Email body is empty")
  }
  if (!input.to.trim()) {
    throw new AurinkoError(400, "Missing recipient")
  }

  const body: Record<string, unknown> = {
    subject: trimmedSubject,
    body: trimmedBody,
    bodyType: "text",
    to: [{ address: input.to.trim() }],
  }
  if (input.cc?.trim()) {
    body.cc = [{ address: input.cc.trim() }]
  }

  const res = await fetch(`${AURINKO_API_BASE}/email/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new AurinkoError(res.status, `Email send failed: ${raw.slice(0, 300)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AurinkoError(500, "Email send response was not JSON")
  }
  const obj = parsed as { id?: string | number }
  return { id: obj.id !== undefined ? String(obj.id) : "" }
}

// ---------- calendar ----------

export type AurinkoCalendarEvent = {
  id: string
  subject: string | null
  start: string | null
  end: string | null
  location: string | null
}

type RawCalendarEvent = {
  id?: string
  subject?: string | null
  start?: { dateTime?: string | null; timezone?: string | null } | string | null
  end?: { dateTime?: string | null; timezone?: string | null } | string | null
  location?: string | null
}

function normalizeEventDateTime(
  value: RawCalendarEvent["start"]
): string | null {
  if (!value) return null
  if (typeof value === "string") return value
  return value.dateTime ?? null
}

function normalizeEvent(raw: RawCalendarEvent): AurinkoCalendarEvent {
  return {
    id: raw.id ?? "",
    subject: raw.subject ?? null,
    start: normalizeEventDateTime(raw.start),
    end: normalizeEventDateTime(raw.end),
    location: raw.location ?? null,
  }
}

/**
 * Lists events from a calendar in a time range. Aurinko's range
 * endpoint is POST /v1/calendars/{id}/events/range with timeMin/
 * timeMax in ISO 8601.
 */
export async function listCalendarEvents(
  accessToken: string,
  calendarId: string,
  range: { timeMin: string; timeMax: string }
): Promise<AurinkoCalendarEvent[]> {
  const url = `${AURINKO_API_BASE}/calendars/${encodeURIComponent(
    calendarId
  )}/events/range`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      timeMin: range.timeMin,
      timeMax: range.timeMax,
    }),
  })
  const body = await res.text()
  if (!res.ok) {
    throw new AurinkoError(res.status, `Event list failed: ${body.slice(0, 200)}`)
  }
  const obj = JSON.parse(body) as { records?: RawCalendarEvent[] }
  return (obj.records ?? []).map(normalizeEvent)
}

export type CreateEventInput = {
  subject: string
  startIso: string
  endIso: string
  timezone?: string
  location?: string | null
  attendeeEmail?: string | null
}

/**
 * Creates a calendar event. POST /v1/calendars/{id}/events.
 * Pilot scope uses calendarId = "primary" which Aurinko resolves to
 * the connected account's main calendar.
 */
export async function createCalendarEvent(
  accessToken: string,
  calendarId: string,
  input: CreateEventInput
): Promise<AurinkoCalendarEvent> {
  const tz = input.timezone ?? "UTC"
  const body: Record<string, unknown> = {
    subject: input.subject,
    start: { dateTime: input.startIso, timezone: tz },
    end: { dateTime: input.endIso, timezone: tz },
  }
  if (input.location) body.location = input.location
  if (input.attendeeEmail) {
    body.meetingInfo = {
      attendees: [
        {
          emailAddress: { address: input.attendeeEmail },
          type: "required",
        },
      ],
    }
  }

  const res = await fetch(
    `${AURINKO_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }
  )
  const raw = await res.text()
  if (!res.ok) {
    throw new AurinkoError(res.status, `Event create failed: ${raw.slice(0, 200)}`)
  }
  return normalizeEvent(JSON.parse(raw) as RawCalendarEvent)
}

/**
 * Verifies the X-Aurinko-Signature header against the raw POST body using
 * the app's signing secret. Format mirrors Slack's `v0:{timestamp}:{body}`
 * signed string with HMAC-SHA256. Replay protection: reject anything older
 * than 5 minutes.
 */
export function verifyAurinkoSignature(input: {
  rawBody: string
  timestamp: string | null
  signature: string | null
}): boolean {
  const signingSecret = process.env.AURINKO_SIGNING_SECRET?.trim()
  if (!signingSecret) return false
  if (!input.timestamp || !input.signature) return false

  const ts = Number.parseInt(input.timestamp, 10)
  if (!Number.isFinite(ts)) return false
  // Aurinko sends seconds; tolerate ms by normalizing if obviously ms-sized.
  const seconds = ts > 1e12 ? Math.floor(ts / 1000) : ts
  const ageSeconds = Math.abs(Date.now() / 1000 - seconds)
  if (ageSeconds > 300) return false

  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest("hex")

  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature.trim())
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ---------- per-shop token helper ----------

type ShopForAurinkoToken = Pick<
  ShopRow,
  | "id"
  | "aurinko_account_id"
  | "aurinko_access_token_enc"
  | "aurinko_token_expires_at"
>

/**
 * Returns a usable Aurinko access token for the shop, refreshing
 * transparently when the stored token is within REFRESH_BUFFER_MS
 * of expiry. Persists the new token + expiry before returning so
 * concurrent callers share the fresh one.
 *
 * Returns null when there's no token to start with — callers should
 * treat that as "Aurinko not connected" rather than an error. Throws
 * AurinkoError on refresh failure (revoked grant, etc.) so callers
 * can prompt a reconnect.
 */
export async function getAccessTokenForShop(
  supabase: SupabaseClient,
  shop: ShopForAurinkoToken
): Promise<string | null> {
  const decrypted = tryDecryptSecret(shop.aurinko_access_token_enc)
  if (!decrypted) return null
  if (!shop.aurinko_account_id) return decrypted // pre-refresh-era shops

  const expiresAtMs = shop.aurinko_token_expires_at
    ? new Date(shop.aurinko_token_expires_at).getTime()
    : 0
  // No expiry recorded → assume long-lived; only refresh when the
  // existing call fails. Treat 0 as "unknown, don't preemptively
  // refresh" so we don't burn an extra round-trip on every send.
  const stale =
    expiresAtMs > 0 && expiresAtMs - Date.now() < REFRESH_BUFFER_MS
  if (!stale) return decrypted

  let next
  try {
    next = await refreshAccessToken(shop.aurinko_account_id)
  } catch (err) {
    console.warn("[aurinko] preemptive refresh failed:", err)
    throw err
  }

  const { error } = await supabase
    .from("shops")
    .update({
      aurinko_access_token_enc: encryptSecret(next.accessToken),
      aurinko_token_expires_at: next.expiresAt,
    })
    .eq("id", shop.id)
  if (error) {
    console.error("[aurinko] failed to persist refreshed token:", error)
  }
  return next.accessToken
}
