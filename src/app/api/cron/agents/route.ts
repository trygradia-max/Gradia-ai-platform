/**
 * Custom-agent runtime cron. Runs hourly (see vercel.json) and fires
 * every enabled agent whose cadence window is open AND that hasn't
 * fired within its minimum-gap.
 *
 * Auth identical to /api/cron/reminders — Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` and we fail-closed if it's
 * missing or mismatched.
 */

import { runScheduledAgents } from "@/lib/agent-runtime"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/agents] CRON_SECRET not configured")
    return unauthorized()
  }
  const provided = request.headers.get("authorization")
  if (provided !== `Bearer ${expected}`) {
    return unauthorized()
  }

  const supabase = createServiceClient()

  try {
    const summary = await runScheduledAgents(supabase)
    return Response.json({ ok: true, ...summary })
  } catch (err) {
    console.error("[cron/agents] runScheduledAgents failed:", err)
    return Response.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Custom-agent runtime crashed.",
      },
      { status: 500 }
    )
  }
}
