/**
 * Cron run wrapper (P0-012): one mechanical pattern for every scheduled
 * route — success/failure heartbeat stamps + exactly one ops alert when a
 * sweep fails. Wraps the route's own handler (auth stays inside the route;
 * a 401 is an auth refusal, not a sweep failure, and stamps nothing).
 *
 * Failure = the handler throws, or returns a 5xx. Either way: one SEV-2
 * alert naming the cron with a sanitized error summary, a failure stamp,
 * and the handler's normal error status is preserved (a throw becomes the
 * 500 the route would have produced). Success = a non-5xx response → a
 * success stamp. Stamps are best-effort: a heartbeat write failure logs
 * and never changes the cron's outcome.
 *
 * Tenant-blind by construction: the only table touched is cron_heartbeats
 * (keyed by cron name; deny-all RLS; service role). No request input is
 * read here.
 */

import { sendOpsAlert } from "@/lib/alerts"
import { createServiceClient } from "@/lib/supabase/service"

/** Every vercel.json cron, with its expected period — test-locked both ways. */
export const CRON_REGISTRY = {
  agents: { periodMinutes: 60 },
  automations: { periodMinutes: 5 },
  "no-show-ladder": { periodMinutes: 60 },
  "provider-events-prune": { periodMinutes: 24 * 60 },
  reconcile: { periodMinutes: 24 * 60 },
  "recovery-retention": { periodMinutes: 24 * 60 },
  reminders: { periodMinutes: 60 },
  "roi-receipt": { periodMinutes: 7 * 24 * 60 },
  "voice-sync": { periodMinutes: 60 },
} as const

export type CronName = keyof typeof CRON_REGISTRY

export const CRON_NAMES = Object.keys(CRON_REGISTRY) as CronName[]

/** A cron is stale when its last success is older than 2× its period + grace. */
const STALE_FACTOR = 2
const STALE_GRACE_MS = 10 * 60_000
const MAX_ERROR_CHARS = 200

export function staleAfterMs(name: CronName): number {
  return CRON_REGISTRY[name].periodMinutes * 60_000 * STALE_FACTOR + STALE_GRACE_MS
}

type StampOutcome = { ok: true } | { ok: false; error: string }

type HeartbeatClient = {
  from: (table: string) => {
    upsert: (
      values: Record<string, unknown>,
      opts: { onConflict: string }
    ) => PromiseLike<{ error: { message: string } | null }>
  }
}

/** Best-effort heartbeat upsert. Never throws. */
export async function stampCronHeartbeat(
  name: string,
  outcome: StampOutcome,
  client?: HeartbeatClient
): Promise<void> {
  const now = new Date().toISOString()
  try {
    const db = client ?? (createServiceClient() as unknown as HeartbeatClient)
    const values = outcome.ok
      ? { name, last_success_at: now, last_error: null, updated_at: now }
      : { name, last_failure_at: now, last_error: outcome.error.slice(0, MAX_ERROR_CHARS), updated_at: now }
    const { error } = await db.from("cron_heartbeats").upsert(values, { onConflict: "name" })
    if (error) console.error(`[cron/${name}] heartbeat stamp failed:`, error.message)
  } catch (err) {
    console.error(`[cron/${name}] heartbeat stamp failed:`, err instanceof Error ? err.message : err)
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS)
}

async function extractErrorSummary(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown }
    if (body && typeof body.error === "string" && body.error.trim()) {
      return body.error.slice(0, MAX_ERROR_CHARS)
    }
  } catch {
    // non-JSON body — fall through
  }
  return `HTTP ${res.status}`
}

async function reportCronFailure(name: CronName, message: string, error?: unknown): Promise<void> {
  await stampCronHeartbeat(name, { ok: false, error: message })
  await sendOpsAlert({
    severity: "SEV-2",
    source: `cron/${name}`,
    title: `Cron ${name} failed`,
    detail: message,
    refs: {
      cron: name,
      action: "sweep aborted — no partial retry",
      retryable: "next scheduled tick",
    },
    error,
  })
}

/**
 * Wrap a cron route handler. Usage in every `src/app/api/cron/<name>/route.ts`:
 *   export const GET = (request: Request) => runCron("<name>", request, handle)
 */
export async function runCron(
  name: CronName,
  request: Request,
  handle: (request: Request) => Promise<Response>
): Promise<Response> {
  let res: Response
  try {
    res = await handle(request)
  } catch (err) {
    const message = errorMessage(err)
    console.error(`[cron/${name}] unhandled failure:`, message)
    await reportCronFailure(name, message, err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
  if (res.status === 401) return res
  if (res.status >= 500) {
    await reportCronFailure(name, await extractErrorSummary(res))
    return res
  }
  await stampCronHeartbeat(name, { ok: true })
  return res
}

export type CronHeartbeatRow = {
  name: string
  last_success_at: string | null
  last_failure_at: string | null
}

export type CronHealth = {
  lastSuccessAt: string | null
  lastFailureAt: string | null
  /** true = last run succeeded; false = last run failed; null = never ran. */
  ok: boolean | null
  /** true = last success older than 2× period + grace; null = never succeeded. */
  stale: boolean | null
}

/** Pure: heartbeat rows → per-cron health for /api/health. */
export function summarizeCronHealth(
  rows: CronHeartbeatRow[],
  nowMs: number
): Record<CronName, CronHealth> {
  const byName = new Map(rows.map((r) => [r.name, r]))
  const out = {} as Record<CronName, CronHealth>
  for (const name of CRON_NAMES) {
    const row = byName.get(name)
    const lastSuccessAt = row?.last_success_at ?? null
    const lastFailureAt = row?.last_failure_at ?? null
    const successMs = lastSuccessAt ? Date.parse(lastSuccessAt) : null
    const failureMs = lastFailureAt ? Date.parse(lastFailureAt) : null
    let ok: boolean | null = null
    if (successMs !== null || failureMs !== null) {
      ok = failureMs === null || (successMs !== null && successMs >= failureMs)
    }
    out[name] = {
      lastSuccessAt,
      lastFailureAt,
      ok,
      stale: successMs === null ? null : nowMs - successMs > staleAfterMs(name),
    }
  }
  return out
}
