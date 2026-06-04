/**
 * Meta Messenger Platform webhook utilities (server-only).
 *
 * Pilot auth model: one global Meta App (META_APP_SECRET +
 * META_WEBHOOK_VERIFY_TOKEN in env). Each shop pastes their IG
 * Business Account ID + Page Access Token (encrypted at rest) into
 * /settings after going through the Meta developer dashboard.
 * OAuth automation is a follow-up — see docs/meta-go-live.md.
 *
 * Signature: `X-Hub-Signature-256` header, format `sha256=<hex>`,
 * HMAC-SHA256 of the raw request body with the App Secret.
 *
 * Docs: https://developers.facebook.com/docs/messenger-platform/instagram
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export type MetaMessageEvent = {
  /** Page-scoped sender id. Opaque per app, stable per user/page pair. */
  senderId: string
  /** Page-scoped recipient id (our shop's page). */
  recipientId: string
  /** When Meta says it happened (ms epoch). */
  timestamp: number
  /** Message id from Meta. */
  messageId: string | null
  /** Plain text body, or null for attachment-only messages. */
  text: string | null
}

type RawAttachment = { type?: string; payload?: { url?: string } }
type RawMessage = {
  mid?: string
  text?: string | null
  attachments?: RawAttachment[]
}
type RawMessaging = {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: RawMessage
}
type RawEntry = {
  id?: string
  time?: number
  messaging?: RawMessaging[]
}
export type MetaWebhookPayload = {
  object?: string
  entry?: RawEntry[]
}

/**
 * Verifies the X-Hub-Signature-256 header. Returns false when the
 * App Secret isn't configured (fail closed).
 */
export function verifyMetaSignature(input: {
  rawBody: string
  signature: string | null
}): boolean {
  const secret = process.env.META_APP_SECRET?.trim()
  if (!secret) return false
  if (!input.signature) return false

  const [scheme, hex] = input.signature.split("=")
  if (scheme !== "sha256" || !hex) return false

  const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex")
  const a = Buffer.from(expected)
  const b = Buffer.from(hex.trim())
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Pulls every message event out of Meta's webhook envelope.
 * One webhook delivery can contain multiple entries (one per page)
 * each with multiple messaging events. We flatten them and dedup
 * obvious echoes (messages our own page sent — they show up here
 * too via the page subscription).
 */

// ---------- outbound: Meta Send API ----------

// Env-overridable so tests can point the executor at a mock server.
const GRAPH_API_BASE =
  process.env.META_GRAPH_API_BASE?.trim() || "https://graph.facebook.com/v22.0"

export class MetaSendError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "MetaSendError"
  }
}

export type MetaSendResult = {
  messageId: string | null
  recipientId: string
}

/**
 * Sends an Instagram DM via the connected page.
 * Endpoint: POST /v22.0/me/messages?access_token=PAGE_TOKEN
 * Body: { recipient: { id: <page-scoped sender id> }, message: { text } }
 *
 * Caller is responsible for HITL — this is the raw API wrapper used
 * by the approval engine after a send_instagram_dm pending_action
 * is approved. 24h window restrictions apply on Meta's side; pilot
 * approvals happen well within that.
 */
export async function sendInstagramDirectMessage(input: {
  pageAccessToken: string
  recipientId: string
  text: string
}): Promise<MetaSendResult> {
  const text = input.text.trim()
  if (!text) throw new MetaSendError(400, "Empty message body")
  if (!input.recipientId.trim()) {
    throw new MetaSendError(400, "Missing recipient (page-scoped sender id)")
  }
  if (!input.pageAccessToken.trim()) {
    throw new MetaSendError(500, "Missing page access token")
  }

  const url = `${GRAPH_API_BASE}/me/messages?access_token=${encodeURIComponent(input.pageAccessToken)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      recipient: { id: input.recipientId.trim() },
      message: { text },
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new MetaSendError(res.status, `IG send failed: ${raw.slice(0, 300)}`)
  }
  let parsed: { message_id?: string; recipient_id?: string }
  try {
    parsed = JSON.parse(raw) as { message_id?: string; recipient_id?: string }
  } catch {
    throw new MetaSendError(500, "IG send response was not JSON")
  }
  return {
    messageId: parsed.message_id ?? null,
    recipientId: parsed.recipient_id ?? input.recipientId,
  }
}

/**
 * Sends a Facebook Page DM. Same Graph endpoint as IG
 * (POST /me/messages) — only the access token differs (FB Page token
 * vs the IG-linked Page token). Kept as a separate function so the
 * approval engine can dispatch on the action type without branching
 * on channel inside one wrapper.
 */
export async function sendFacebookPageMessage(input: {
  pageAccessToken: string
  recipientId: string
  text: string
}): Promise<MetaSendResult> {
  const text = input.text.trim()
  if (!text) throw new MetaSendError(400, "Empty message body")
  if (!input.recipientId.trim()) {
    throw new MetaSendError(400, "Missing recipient (PSID)")
  }
  if (!input.pageAccessToken.trim()) {
    throw new MetaSendError(500, "Missing FB page access token")
  }

  const url = `${GRAPH_API_BASE}/me/messages?access_token=${encodeURIComponent(input.pageAccessToken)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      recipient: { id: input.recipientId.trim() },
      message: { text },
    }),
  })
  const raw = await res.text()
  if (!res.ok) {
    throw new MetaSendError(res.status, `FB send failed: ${raw.slice(0, 300)}`)
  }
  let parsed: { message_id?: string; recipient_id?: string }
  try {
    parsed = JSON.parse(raw) as { message_id?: string; recipient_id?: string }
  } catch {
    throw new MetaSendError(500, "FB send response was not JSON")
  }
  return {
    messageId: parsed.message_id ?? null,
    recipientId: parsed.recipient_id ?? input.recipientId,
  }
}

export function extractMessageEvents(
  payload: MetaWebhookPayload
): {
  pageId: string
  events: MetaMessageEvent[]
}[] {
  if (!payload?.entry) return []
  const buckets: { pageId: string; events: MetaMessageEvent[] }[] = []
  for (const entry of payload.entry) {
    const pageId = entry.id?.trim()
    if (!pageId) continue
    const events: MetaMessageEvent[] = []
    for (const m of entry.messaging ?? []) {
      const senderId = m.sender?.id?.trim()
      const recipientId = m.recipient?.id?.trim()
      if (!senderId || !recipientId || !m.message) continue
      // Skip echoes — when our page itself sent the message, sender =
      // page id. The recipient is the customer in that case. The
      // dedupe rule: an event where senderId === pageId is outbound.
      if (senderId === pageId) continue
      events.push({
        senderId,
        recipientId,
        timestamp: m.timestamp ?? Date.now(),
        messageId: m.message.mid ?? null,
        text: m.message.text?.trim() || null,
      })
    }
    if (events.length > 0) buckets.push({ pageId, events })
  }
  return buckets
}
