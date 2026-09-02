/**
 * Nightly telephony reconciliation cron (see vercel.json — 08:00 UTC,
 * after Twilio's usage records settle for the prior day). Compares the
 * usage_events ledger against Twilio Usage Records per shop subaccount
 * and alerts on >2% month-to-date drift. Read-only on both sides — it
 * never writes corrections; a confirmed gap gets a compensating ledger
 * entry by hand.
 *
 * Auth identical to the other crons: Vercel sends
 * `Authorization: Bearer <CRON_SECRET>`; fail closed without it.
 */

import { runCron } from "@/lib/cron-run"
import { detectUsageAnomalies } from "@/lib/monitoring"
import { reconcileTwilioUsage } from "@/lib/reconciliation"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

async function handle(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/reconcile] CRON_SECRET not configured")
    return unauthorized()
  }
  const provided = request.headers.get("authorization")
  if (provided !== `Bearer ${expected}`) {
    return unauthorized()
  }

  try {
    const supabase = createServiceClient()
    const summary = await reconcileTwilioUsage(supabase)
    // Piggyback the nightly anomaly scan — spend spikes, sub-floor margin, and
    // the global daily ceiling. Best-effort; a scan failure must not fail the
    // reconciliation it rides on.
    let anomalies = 0
    try {
      anomalies = (await detectUsageAnomalies(supabase)).length
    } catch (scanErr) {
      console.error("[cron/reconcile] anomaly scan failed:", scanErr)
    }
    return Response.json({
      ok: true,
      checked: summary.checked,
      skipped: summary.skipped,
      drifting: summary.drifting.length,
      shops: summary.drifting,
      anomalies,
    })
  } catch (err) {
    console.error("[cron/reconcile] failed:", err)
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Reconciliation crashed.",
      },
      { status: 500 }
    )
  }
}

/** P0-012: every cron runs through one wrapper — heartbeat stamps + one ops alert on failure. */
export const GET = (request: Request) => runCron("reconcile", request, handle)
