/**
 * Commercial Billing worker cron (PR F2, sandbox/test mode only; PR F3 adds subscription polling). Sweeps pending settlement deliveries, reconciles
 * `unknown` deliveries (evidence only, never a resend), applies human-approved adjustments and polls due subscriptions
 * (GET-only reads, applied only through the single subscription writer). Cross-tenant by design
 * like the other crons, but every item is bound to its own shop by the database row; nothing in the request names a
 * tenant, period, customer, event or amount.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (the repository's cron mechanism). Fails closed. GET only.
 * Disabled (200 `disabled`) unless GRADIA_COMMERCIAL_BILLING_WORKER=enabled; enabled but misconfigured is a 503
 * (the cron wrapper alerts). Production activation stays a separate reviewed release decision; the production
 * write guards, Stripe live mode and automatic deployments are untouched by this route.
 */

import { runCommercialBillingWorker, resolveCommercialWorkerConfig, resolveWorkerDeps } from "@/lib/commercial-billing-worker"
import { runCron } from "@/lib/cron-run"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return new Response("Unauthorized", { status: 401 })
}

async function handle(request: Request) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    console.error("[cron/commercial-billing] CRON_SECRET not configured")
    return unauthorized()
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) return unauthorized()

  const config = resolveCommercialWorkerConfig(process.env)
  if (!config.ok && config.status === "disabled") return Response.json({ ok: true, status: "disabled" })
  if (!config.ok) return Response.json({ ok: false, status: "misconfigured", reason: config.reason }, { status: 503 })

  try {
    const report = await runCommercialBillingWorker(createServiceClient(), resolveWorkerDeps(process.env))
    // Counts and finite codes only: never an id, payload, URL or secret.
    console.info(`[cron/commercial-billing] ok=${report.ok} ${report.tasks.map((t) => `${t.worker}:${t.status === "ran" ? t.outcome : `skipped_${t.reason}`}`).join(" ")}`)
    return Response.json(report, { status: report.ok ? 200 : 503 })
  } catch {
    console.error("[cron/commercial-billing] run failed")
    return Response.json({ ok: false, status: "failed" }, { status: 500 })
  }
}

export const GET = (request: Request) => runCron("commercial-billing", request, handle)
