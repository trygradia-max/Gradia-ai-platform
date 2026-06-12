/**
 * TrustHub / A2P registration status callback.
 *
 * Twilio POSTs here as the shop's customer profile, trust product, brand,
 * or campaign moves through review (the callback URL carries ?shop=<id>,
 * set when registration started). We don't parse the event payload —
 * stage truth lives at Twilio, so we just run syncA2pStatus, which polls
 * the current stage and advances the pipeline idempotently. The same
 * function backs the manual "check status" refresh in settings, so a
 * missed webhook never wedges a registration.
 *
 * Signature is verified against the shop's SUBACCOUNT token — TrustHub
 * resources live under the subaccount, so that's the signing key. Fail
 * closed on any mismatch.
 */

import { headers } from "next/headers"

import { createServiceClient } from "@/lib/supabase/service"
import { syncA2pStatus } from "@/lib/telephony-provider"
import { tryDecryptSecret } from "@/lib/crypto"
import { verifyTwilioSignature } from "@/lib/twilio"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function resolvePublicUrl(request: Request): Promise<string> {
  const url = new URL(request.url)
  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  if (configured) {
    try {
      return `${new URL(configured).origin}${url.pathname}${url.search}`
    } catch {
      // fall through
    }
  }
  const h = await headers()
  const forwardedHost = h.get("x-forwarded-host")
  if (forwardedHost) {
    const proto = h.get("x-forwarded-proto") ?? "https"
    return `${proto}://${forwardedHost}${url.pathname}${url.search}`
  }
  return request.url
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const publicUrl = await resolvePublicUrl(request)
  const signature = request.headers.get("x-twilio-signature")

  const shopId = new URL(request.url).searchParams.get("shop")
  if (!shopId) return new Response("Missing shop", { status: 400 })

  const supabase = createServiceClient()
  const { data } = await supabase
    .from("shops")
    .select("*")
    .eq("id", shopId)
    .maybeSingle()
  const shop = (data as ShopRow | null) ?? null
  if (!shop) return new Response("Unknown shop", { status: 404 })

  const subToken = tryDecryptSecret(shop.twilio_subaccount_token_enc)
  if (!shop.twilio_subaccount_sid || !subToken) {
    return new Response("No subaccount", { status: 404 })
  }
  const verified = verifyTwilioSignature({
    url: publicUrl,
    form: new URLSearchParams(rawBody),
    signature,
    creds: { accountSid: shop.twilio_subaccount_sid, authToken: subToken },
  })
  if (!verified) return new Response("Invalid signature", { status: 401 })

  const origin = new URL(publicUrl).origin
  const result = await syncA2pStatus({ supabase, shop, origin })
  return Response.json({ ok: true, status: result.status })
}
