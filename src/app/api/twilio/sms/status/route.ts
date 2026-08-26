/**
 * Twilio SMS delivery-status callback.
 *
 * Twilio POSTs here every time an outbound message transitions
 * status: queued → sent → delivered (or failed / undelivered). The
 * body shape is the same form-encoded format as inbound SMS, with
 * MessageSid + MessageStatus + ErrorCode (on failures).
 *
 * Credential resolution (P0-008): the callback URL carries `?shop=<id>`
 * (appended by every send/provision path), and the shop's credentials
 * resolve in the SAME order as the inbound webhook — subaccount → BYO →
 * env master (`resolveTwilioCredentials`). Gradia-provisioned numbers
 * live on the shop's subaccount, so Twilio signs their callbacks with
 * the SUBACCOUNT token; resolving only BYO columns (the pre-P0-008 bug)
 * made every subaccount callback fail verification silently.
 *
 * The `shop` query param is inside the signed URL, so it cannot be
 * tampered with without breaking the signature. It selects which shop's
 * signing key the request must verify against — passing verification
 * proves possession of that shop's Twilio auth token. It is still never
 * trusted as an authorization primitive on its own: the interaction
 * lookup/update below is scoped to the same shop, so a tenant signing
 * with their OWN token can never mutate another tenant's rows, whatever
 * MessageSid they put in the body. An unknown `?shop=` rejects — never
 * falls back to another credential class (no cross-shop guessing).
 * Requests without the param (legacy master-account callback URLs)
 * verify against the env master token only.
 *
 * We look up the interaction row by `metadata.twilio_message_sid`
 * (scoped to the verified shop) and update `metadata.twilio_status` /
 * `metadata.twilio_error_code` in place. Done with a read-modify-write —
 * Supabase JS doesn't expose jsonb merge directly, and the race window
 * is small enough at pilot scale that we'd rather keep the code simple.
 * Twilio retries on non-2xx, and the writes are idempotent (last status
 * wins), so DB failures return 5xx and let the retry land the update.
 *
 * Returns 200 + empty TwiML on every accepted callback so Twilio stops
 * retrying — even when we can't find a matching interaction (the row
 * may not have been inserted yet, see comment inline).
 */

import { headers } from "next/headers"

import {
  EMPTY_TWIML_RESPONSE,
  parseInboundSms,
  resolveTwilioCredentials,
  verifyTwilioSignature,
  type TwilioCredentials,
} from "@/lib/twilio"
import { createServiceClient } from "@/lib/supabase/service"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const TWIML_HEADERS = { "Content-Type": "text/xml; charset=utf-8" }

/** The shop columns credential resolution needs — includes the
 *  subaccount + Gradia-number fields the pre-P0-008 select omitted. */
const SHOP_CRED_COLUMNS =
  "twilio_account_sid_enc, twilio_auth_token_enc, twilio_subaccount_sid, twilio_subaccount_token_enc, twilio_phone_number, gradia_number_e164"

type ShopCredRow = Pick<
  ShopRow,
  | "twilio_account_sid_enc"
  | "twilio_auth_token_enc"
  | "twilio_subaccount_sid"
  | "twilio_subaccount_token_enc"
  | "twilio_phone_number"
  | "gradia_number_e164"
>

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

  const shopId = new URL(request.url).searchParams.get("shop")
  const supabase = createServiceClient()

  let creds: TwilioCredentials | null = null
  if (shopId) {
    const { data, error: shopErr } = await supabase
      .from("shops")
      .select(SHOP_CRED_COLUMNS)
      .eq("id", shopId)
      .maybeSingle()
    if (shopErr) {
      // 5xx keeps Twilio's retry open — the update is last-write-wins,
      // so a retry after the DB recovers is harmless.
      console.error("[twilio status] shop lookup failed:", {
        shopId,
        error: shopErr.message,
      })
      return new Response("Server error", { status: 500 })
    }
    if (!data) {
      // Never fall back to another credential class for an unknown shop
      // id — that would let an arbitrary query param pick the env master
      // token (cross-shop guessing). Reject, loudly.
      console.warn("[twilio status] verification rejected:", {
        shopId,
        shopResolved: false,
        credentialSource: "none",
        reason: "unknown shop",
      })
      return new Response("Unknown shop", { status: 404 })
    }
    creds = resolveTwilioCredentials(data as ShopCredRow | null)
  } else {
    // Legacy callback URLs without ?shop= only ever came from
    // master-account sends — env master is the only valid signer.
    creds = resolveTwilioCredentials(null)
  }

  if (!creds) {
    // A shop with no resolvable credentials means reject, not skip
    // verification (fail closed). This is the silent-death mode P0-008
    // eliminates — log the credential-class outcome, never the tokens.
    console.warn("[twilio status] verification rejected:", {
      shopId: shopId ?? null,
      shopResolved: Boolean(shopId),
      credentialSource: "none",
      reason: "no resolvable credentials",
    })
    return new Response("Invalid signature", { status: 401 })
  }

  if (!verifyTwilioSignature({ url: publicUrl, form, signature, creds })) {
    console.warn("[twilio status] verification rejected:", {
      shopId: shopId ?? null,
      shopResolved: Boolean(shopId),
      credentialSource: creds.source ?? "unknown",
      reason: "signature mismatch",
    })
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

  console.info("[twilio status] verified callback:", {
    shopId: shopId ?? null,
    credentialSource: creds.source ?? "unknown",
    messageSid,
    status: newStatus,
  })

  // Read-modify-write the JSON metadata. We match on the message SID
  // via the existing GIN-friendly jsonb operator, scoped to the shop
  // whose credentials verified the request — the same MessageSid (or a
  // malicious one in the body) can never select another tenant's row.
  // If the row hasn't been inserted yet (Twilio's callback raced our
  // send-then-record path) we just no-op and rely on the next status
  // transition to catch up. Twilio sends queued → sent → delivered
  // separately.
  let lookup = supabase
    .from("interactions")
    .select("id, shop_id, metadata")
    .eq("channel", "sms")
    .eq("metadata->>twilio_message_sid", messageSid)
  if (shopId) lookup = lookup.eq("shop_id", shopId)
  const { data: row, error: fetchErr } = await lookup.maybeSingle()

  if (fetchErr) {
    console.error("[twilio status] lookup failed:", {
      shopId: shopId ?? null,
      messageSid,
      error: fetchErr.message,
    })
    return new Response("Server error", { status: 500 })
  }
  if (!row) {
    // Either the send-side insert hasn't landed yet, or this is for a
    // message we didn't send / another tenant's message (signature-
    // verified, shop-scoped lookup found nothing). Acknowledge with
    // zero writes — never create state just to satisfy Twilio.
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
    .eq("shop_id", row.shop_id)

  if (updateErr) {
    // A lost terminal status has no later transition to self-heal from —
    // 5xx so Twilio retries (the rewrite is idempotent).
    console.error("[twilio status] metadata update failed:", {
      shopId: shopId ?? null,
      messageSid,
      error: updateErr.message,
    })
    return new Response("Server error", { status: 500 })
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
