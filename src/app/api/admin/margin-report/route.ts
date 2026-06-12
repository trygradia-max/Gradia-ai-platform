/**
 * Per-shop gross-margin report (founder/ops only — same bearer secret as
 * the crons; this is not a shop-facing surface and wholesale costs must
 * never reach one). Month-to-date by default; ?since=ISO overrides.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     https://<host>/api/admin/margin-report | jq
 */

import { buildMarginReport } from "@/lib/margin-report"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[admin/margin-report] CRON_SECRET not configured")
    return new Response("Unauthorized", { status: 401 })
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const since = new URL(request.url).searchParams.get("since")
  try {
    const report = await buildMarginReport(createServiceClient(), {
      since: since ?? undefined,
    })
    return Response.json(report)
  } catch (err) {
    console.error("[admin/margin-report] failed:", err)
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "report failed" },
      { status: 500 }
    )
  }
}
