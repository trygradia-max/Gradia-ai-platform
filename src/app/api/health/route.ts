/**
 * GET /api/health (P0-012) — the "is it up" endpoint for an external uptime
 * pinger. Deliberately unauthenticated, therefore reviewed for disclosure:
 *
 *   Contract (JSON, `Cache-Control: no-store`):
 *   {
 *     status: "ok" | "degraded" | "down",   // down ⇒ HTTP 503, else 200
 *     ok: boolean,                            // status !== "down"
 *     at: ISO timestamp,
 *     checks: {
 *       db:     { ok, latencyMs },            // one cheap service-role read
 *       alerts: { webhookConfigured, smsConfigured, delivered, failed,
 *                 suppressed, invalid, lastDeliveredAt, lastFailureAt },
 *       crons:  { <name>: { lastSuccessAt, lastFailureAt, ok, stale } }
 *     }
 *   }
 *
 *   NOT in the response, by design: tenant data of any kind, env var names
 *   or values, versions, error messages / stack traces (last_error stays in
 *   the alert + log), destination URLs. Cron names are route paths that are
 *   already public. `degraded` = any cron whose last run failed or whose
 *   last success is stale; `down` = the database read failed or timed out.
 *
 * Cheap on purpose (one bounded SELECT); no rate limit yet — add one if the
 * pinger load ever becomes measurable (ticket failure-case note).
 */

import { alertSeamStatus } from "@/lib/alerts"
import { summarizeCronHealth, type CronHeartbeatRow } from "@/lib/cron-run"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DB_TIMEOUT_MS = 3_000

async function readHeartbeats(): Promise<{ ok: boolean; latencyMs: number | null; rows: CronHeartbeatRow[] }> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const query = createServiceClient()
      .from("cron_heartbeats")
      .select("name, last_success_at, last_failure_at")
      .limit(50)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS)
    })
    const { data, error } = await Promise.race([query, timeout])
    if (error) throw new Error(error.message)
    return { ok: true, latencyMs: Date.now() - started, rows: (data as CronHeartbeatRow[] | null) ?? [] }
  } catch (err) {
    console.error("[health] db check failed:", err instanceof Error ? err.message : err)
    return { ok: false, latencyMs: null, rows: [] }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function GET() {
  const now = Date.now()
  const db = await readHeartbeats()
  const crons = summarizeCronHealth(db.rows, now)
  const cronTrouble = Object.values(crons).some((c) => c.ok === false || c.stale === true)
  const status: "ok" | "degraded" | "down" = !db.ok ? "down" : cronTrouble ? "degraded" : "ok"

  return Response.json(
    {
      status,
      ok: status !== "down",
      at: new Date(now).toISOString(),
      checks: {
        db: { ok: db.ok, latencyMs: db.latencyMs },
        alerts: alertSeamStatus(),
        crons,
      },
    },
    { status: status === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } }
  )
}
