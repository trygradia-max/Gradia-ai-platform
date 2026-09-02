/**
 * Hourly voice-assistant sync (see vercel.json). Two jobs:
 *
 *   1. Staleness — shops whose KB/services/persona changed since the last
 *      compose (vapi_stale) get re-PATCHed so voice never drifts from chat
 *      (spec §2.2 / sharpening brief P5).
 *   2. Budget fallback — live shops with a minute budget get re-synced so
 *      the over-budget take-a-message fallback flips on promptly after the
 *      marking webhook, and OFF again when the month rolls or the budget
 *      is raised (syncVoiceAssistant decides from current state).
 *
 * Needs GRADIA_DASHBOARD_URL for the webhook server URL — fail loudly
 * rather than composing assistants pointed at localhost.
 */

import { runCron } from "@/lib/cron-run"
import { createServiceClient } from "@/lib/supabase/service"
import { syncVoiceAssistant } from "@/lib/voice-provider"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

async function handle(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/voice-sync] CRON_SECRET not configured")
    return unauthorized()
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return unauthorized()
  }

  const configured = process.env.GRADIA_DASHBOARD_URL?.trim()
  let origin: string
  try {
    origin = new URL(configured ?? "").origin
  } catch {
    console.error("[cron/voice-sync] GRADIA_DASHBOARD_URL missing/invalid")
    return Response.json(
      { ok: false, error: "GRADIA_DASHBOARD_URL not configured" },
      { status: 500 }
    )
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("shops")
    .select("*")
    .not("vapi_assistant_id", "is", null)
    .or("vapi_stale.eq.true,and(voice_live.eq.true,voice_minutes_budget.not.is.null)")
  if (error) {
    console.error("[cron/voice-sync] shop query failed:", error)
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  const shops = (data ?? []) as ShopRow[]
  let synced = 0
  let failed = 0
  for (const shop of shops) {
    const result = await syncVoiceAssistant({ supabase, shop, origin })
    if (result.ok) synced++
    else {
      failed++
      console.error(`[cron/voice-sync] sync failed for ${shop.id}:`, result.error)
    }
  }

  return Response.json({ ok: true, candidates: shops.length, synced, failed })
}

/** P0-012: every cron runs through one wrapper — heartbeat stamps + one ops alert on failure. */
export const GET = (request: Request) => runCron("voice-sync", request, handle)
