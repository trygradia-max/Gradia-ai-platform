/**
 * POST /api/admin/alert-test (P0-012) — the built-in test alert for manual
 * acceptance step 6: after the founder sets OPS_ALERT_WEBHOOK_URL (and
 * optionally the SMS pair) in Production, one authenticated call proves the
 * destination end-to-end. Founder-only via the CRON_SECRET bearer (same
 * gate as /api/admin/margin-report). Fails closed. Sends a SEV-3 that
 * bypasses burst dedupe; the response is the seam's delivery result.
 */

import { sendTestOpsAlert } from "@/lib/alerts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[admin/alert-test] CRON_SECRET not configured")
    return new Response("Unauthorized", { status: 401 })
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return new Response("Unauthorized", { status: 401 })
  }
  let note: string | undefined
  try {
    const body = (await request.json()) as { note?: unknown }
    if (typeof body?.note === "string") note = body.note
  } catch {
    // no body — fine
  }
  const result = await sendTestOpsAlert(note)
  return Response.json({ ok: result.delivered, ...result })
}
