/**
 * Automation catalog cron (CRM C5) — every 5 minutes (vercel.json; the
 * 5-minute cadence exists for new_lead_instant, where speed is the point).
 * Runs the catalog sweeps per shop plus the C4 close sweep (paid → closed
 * after 48h). #5/#6 stay on their own existing crons.
 *
 * Everything downstream is idempotent (automation_runs trigger_ref), stages
 * through pending_actions, and sends only via the one send path with the
 * A2P / quiet-hours / opt-out / credit gates intact — so a 5-minute cadence
 * can never double-send or bypass anything.
 */

import { runCron } from "@/lib/cron-run"
import { closeOldPaidJobs } from "@/lib/jobs"
import { runAutomationSweeps, type SweepStats } from "@/lib/automation-sweeps"
import { runWhisperSuggestionSweep } from "@/lib/whisper-suggestion-sweep"
import { createServiceClient } from "@/lib/supabase/service"
import type { ShopRow } from "@/lib/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

async function handle(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/automations] CRON_SECRET not configured")
    return new Response("Unauthorized", { status: 401 })
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const supabase = createServiceClient()

  // Only shops that can actually text; everything else has nothing to run.
  const { data, error } = await supabase
    .from("shops")
    .select("id, owner_id, name, plan, voice_addon, credit_period_start, settings")
    .not("twilio_phone_number", "is", null)
    .limit(500)
  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }
  const shops =
    (data as Pick<
      ShopRow,
      "id" | "owner_id" | "name" | "plan" | "voice_addon" | "credit_period_start" | "settings"
    >[] | null) ?? []

  const perShop: Record<string, SweepStats> = {}
  let whisperStaged = 0
  for (const shop of shops) {
    try {
      perShop[shop.id] = await runAutomationSweeps(supabase, shop)
    } catch (err) {
      console.error("[cron/automations] sweeps failed for", shop.id, err)
    }
    try {
      // C6a Whisper suggestions — metered per draft with credit pre-check
      // (fail closed inside), idempotent per suggestion ref.
      const whisper = await runWhisperSuggestionSweep(supabase, shop)
      whisperStaged += whisper.staged
    } catch (err) {
      console.error("[cron/automations] whisper sweep failed for", shop.id, err)
    }
  }

  const closed = await closeOldPaidJobs(supabase)

  return Response.json({
    ok: true,
    shops: shops.length,
    closed: closed.closed,
    whisperStaged,
    perShop,
  })
}

/** P0-012: every cron runs through one wrapper — heartbeat stamps + one ops alert on failure. */
export const GET = (request: Request) => runCron("automations", request, handle)
