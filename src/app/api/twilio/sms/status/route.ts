/**
 * Twilio SMS delivery-status callback.
 *
 * Twilio POSTs here every time an outbound message transitions
 * status: queued → sent → delivered (or failed / undelivered). The
 * body shape is the same form-encoded format as inbound SMS, with
 * MessageSid + MessageStatus + ErrorCode (on failures).
 *
 * We look up the interaction row by `metadata.twilio_message_sid`
 * and update `metadata.twilio_status` / `metadata.twilio_error_code`
 * in place. Done with a read-modify-write — Supabase JS doesn't
 * expose jsonb merge directly, and the race window is small enough
 * at pilot scale that we'd rather keep the code simple. Twilio
 * retries on non-2xx, and the writes are idempotent (last status
 * wins).
 *
 * Signature verification reuses the same HMAC-SHA1 scheme as
 * inbound. Returns 200 + empty TwiML on every accepted callback so
 * Twilio stops retrying — even when we can't find a matching
 * interaction (the row may not have been inserted yet, see comment
 * inline).
 */

import { headers } from "next/headers"

import {
  EMPTY_TWIML_RESPONSE,
  parseInboundSms,
  verifyTwilioSignature,
} from "@/lib/twilio"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const TWIML_HEADERS = { "Content-Type": "text/xml; charset=utf-8" }

async function resolvePublicUrl(request: Request): Promise<string> {
  const url = new URL(request.url)
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      const origin = new URL(configured).origin
      return `${origin}${url.pathname}${url.search}`
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const forwardedHost = h.get("x-forwarded-host")
  const forwardedProto = h.get("x-forwarded-proto")
  if (forwardedHost) {
    const proto = forwardedProto ?? "https"
    return `${proto}://${forwardedHost}${url.pathname}${url.search}`
  }
  return request.url
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const form = new URLSearchParams(rawBody)
  const publicUrl = await resolvePublicUrl(request)
  const signature = request.headers.get("x-twilio-signature")

  if (!verifyTwilioSignature({ url: publicUrl, form, signature })) {
    return new Response("Invalid signature", { status: 401 })
  }

  const { parsed, raw } = parseInboundSms(form)
  const messageSid = parsed.messageSid
  if (!messageSid) {
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }

  const newStatus = (raw.MessageStatus ?? raw.SmsStatus ?? "").trim()
  if (!newStatus) {
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }
  const errorCode = (raw.ErrorCode ?? "").trim() || null

  const supabase = createServiceClient()

  // Read-modify-write the JSON metadata. We match on the message SID
  // via the existing GIN-friendly jsonb operator; if the row hasn't
  // been inserted yet (Twilio's callback raced our send-then-record
  // path) we just no-op and rely on the next status transition to
  // catch up. Twilio sends queued → sent → delivered separately.
  const { data: row, error: fetchErr } = await supabase
    .from("interactions")
    .select("id, metadata")
    .eq("channel", "sms")
    .eq("metadata->>twilio_message_sid", messageSid)
    .maybeSingle()

  if (fetchErr) {
    console.error("[twilio status] lookup failed:", fetchErr)
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }
  if (!row) {
    // Either the send-side insert hasn't landed yet, or this is for a
    // message we didn't send (extremely unlikely given signature
    // verification). Acknowledge and move on.
    return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
  }

  const existingMetadata =
    (row.metadata as Record<string, unknown> | null) ?? {}
  const nextMetadata: Record<string, unknown> = {
    ...existingMetadata,
    twilio_status: newStatus,
    twilio_status_updated_at: new Date().toISOString(),
  }
  if (errorCode) nextMetadata.twilio_error_code = errorCode

  const { error: updateErr } = await supabase
    .from("interactions")
    .update({ metadata: nextMetadata })
    .eq("id", row.id)

  if (updateErr) {
    console.error("[twilio status] metadata update failed:", updateErr)
  }

  // Loud warning when something genuinely failed so it shows up in
  // logs without our needing to scan every metadata blob.
  if (newStatus === "failed" || newStatus === "undelivered") {
    console.warn("[twilio status] outbound failed:", {
      messageSid,
      status: newStatus,
      errorCode,
    })
  }

  return new Response(EMPTY_TWIML_RESPONSE, { headers: TWIML_HEADERS })
}
