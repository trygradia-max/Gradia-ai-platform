/**
 * GET/POST /api/intake/meta-lead-ads
 *
 * Meta Lead Ads only. Verify X-Hub-Signature-256 on the raw body before
 * any parse or write. The shop is the page binding in
 * meta_lead_page_bindings. A shop id in the body is not the tenant.
 *
 * Follow-up: meta_graph_lead_field_retrieval. Name, phone, and email are
 * not read from Graph here, and field_data in the body is not stored.
 * This route does not connect OAuth or render a Settings tile.
 */

import {
  acceptMetaLeadAdsIntake,
  metaLeadAdsAppSecret,
  metaLeadAdsVerifyToken,
  parseMetaLeadgenBody,
  readMetaHubChallenge,
  verifyMetaLeadAdsSignature,
} from "@/lib/meta-lead-ads"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const result = readMetaHubChallenge({
    mode: url.searchParams.get("hub.mode"),
    verifyToken: url.searchParams.get("hub.verify_token"),
    challenge: url.searchParams.get("hub.challenge"),
    configuredToken: metaLeadAdsVerifyToken(),
  })
  if (!result.ok) {
    return new Response("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    })
  }
  return new Response(result.challenge, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get("x-hub-signature-256")
  if (!verifyMetaLeadAdsSignature(rawBody, signature, metaLeadAdsAppSecret())) {
    return json({ ok: false, error: "Invalid signature." }, 401)
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return json({ ok: false, error: "Check the lead notification and try again." }, 400)
  }

  const parsed = parseMetaLeadgenBody(body)
  if (!parsed.ok) {
    return json({ ok: false, error: "Check the lead notification and try again." }, 400)
  }
  if (parsed.events.length === 0) {
    return json({ ok: true, recorded: 0 })
  }

  const db = createServiceClient()
  const receivedAt = new Date().toISOString()
  try {
    const accepted = await acceptMetaLeadAdsIntake(db, parsed.events, receivedAt)
    if (!accepted.ok) return json({ ok: false, error: accepted.error }, accepted.status)
    const first = accepted.results[0]
    if (!first) return json({ ok: true, recorded: 0 })
    return json({
      ok: true,
      status: accepted.results.length === 1 ? first.status : "recorded",
      envelope_id: first.envelopeId,
      workflow_id: first.workflowId,
      count: accepted.results.length,
    })
  } catch (err) {
    console.error(
      "[meta-lead-ads] intake failed",
      err instanceof Error ? err.message : "unknown",
    )
    return json({ ok: false, error: "Couldn't save that lead." }, 500)
  }
}
